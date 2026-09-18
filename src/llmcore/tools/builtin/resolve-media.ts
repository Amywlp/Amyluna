/**
 * resolve_media 工具 — 统一媒体标注工具（2026-09-13 重建）。
 *
 * 触发场景：用户引用了一条图片、GIF、视频、音频（文件/语音）、文本文件或
 * 分享卡片（网易云/QQ音乐/视频卡）消息，但上下文中只有占位符
 * （"[图片]" / "[视频]" / "[文件]" / "[语音]" / "[分享卡片]"），LLM 看不到真实内容。
 *
 * 本工具按 message_id 查库取媒体元数据，按类型分派 handler 解析：
 *   - image      → vision 描述（30s 不重试）
 *   - gif        → 下载 → ffmpeg 转 mp4 → 153 vlm-api 时间轴（【新】）
 *   - video      → 下载/yt-dlp → 153 vlm-api 时间轴（能力并入自 analyze_video）
 *   - audio      → 下载 → media-analyzer(9899) 特征+情绪+ASR
 *   - text       → 下载 → /extract-text（乱码校验）
 *   - neteaseCard → 网易云音乐卡：musicUrl 下载 → 音频分析（现有）
 *   - qqMusicCard → QQ音乐卡：musicUrl 下载 → 音频分析（【新】识别 isure.stream.qqmusic.qq.com）
 *   - otherCard  → 标题/跳转；视频卡自动转 video 解析
 *   - unsupported → pdf/zip/rar/7z/exe/torrent 等：结构化占位（未实现，留扩展）
 *
 * 标注回填（本工具核心定位）：
 *   解析成功后把结果**回填到 chat_messages.content**（替换占位符），并更新
 *   group_files.analysis_status；之后同一消息被再次引用时，context-builder 直接
 *   读到回填文本，无需重复调用工具与重复烧模型。
 *   回填截断至 CONTENT_BACKFILL_MAX（4KB）防撑爆 content/上下文。
 *
 * requiresFollowUp=true：调用后 LLM 下一轮收到结果再整合回复。
 */

import type { ToolMeta } from "../types";
import type { MessageRepository } from "../../../common/db/message-repository";
import type { FileRepository } from "../../../common/db/file-repository";
import type { LLMRelay } from "../../llm/relay";
import { describeImages, type VisionConfig } from "../../vision";
import { createLogger } from "../../../common/logger";
import {
  analyzeVideoFromArgs,
  analyzeGifFile,
  downloadGif,
  isGifName,
  isGifUrl,
} from "./media-video";

const log = createLogger("P3.tools");

const AUDIO_ANALYZER_URL = "http://127.0.0.1:9899/analyze";
const TEXT_EXTRACT_URL = "http://127.0.0.1:9899/extract-text";
const IMAGE_TIMEOUT_MS = 30000; // vision 单次 30s，不重试
const AUDIO_TIMEOUT_MS = 80000; // 音频下载+分析：上限给足但低于 LLM 90s
const TEXT_TIMEOUT_MS = 60000;  // 文本下载+提取
/** 回填 content 最大长度（超出截断，防长视频/分析文本撑爆 DB 与上下文） */
const CONTENT_BACKFILL_MAX = 4000;

/** 常见音频扩展名（判断 file 是否音频） */
const AUDIO_EXT = new Set([
  ".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".wma", ".opus", ".amr", ".ape", ".alac", ".mid", ".midi", ".silk",
]);

/** 常见文本扩展名（判断 file 是否文本，走 /extract-text） */
const TEXT_EXT = new Set([
  ".md", ".txt", ".log", ".json", ".yaml", ".yml", ".csv", ".conf", ".ini",
  ".cfg", ".toml", ".xml", ".html", ".htm", ".py", ".js", ".ts", ".sh", ".c",
  ".h", ".cpp", ".java", ".go", ".rs", ".sql", ".env", ".rst", ".tex",
]);

/** 常见视频扩展名（group_files 里的 mp4 等，走 153 vlm） */
const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".flv", ".avi", ".ts", ".3gp", ".m2ts", ".wmv",
]);

/** 已占位（未实现）的文件类型说明 — 后续逐个实现时把扩展名移出本集合即可 */
const UNSUPPORTED_DESC: Record<string, string> = {
  ".pdf": "PDF 文档",
  ".zip": "压缩包",
  ".rar": "压缩包",
  ".7z": "压缩包",
  ".tar": "压缩包",
  ".gz": "压缩包",
  ".xz": "压缩包",
  ".bz2": "压缩包",
  ".torrent": "种子文件",
  ".exe": "可执行程序",
  ".msi": "安装程序",
  ".appimage": "可执行程序",
  ".deb": "安装包",
  ".rpm": "安装包",
  ".iso": "光盘镜像",
  ".doc": "Word 文档",
  ".docx": "Word 文档",
  ".xls": "Excel 表格",
  ".xlsx": "Excel 表格",
  ".ppt": "PPT 演示",
  ".pptx": "PPT 演示",
  ".epub": "电子书",
  ".mobi": "电子书",
};

interface ResolveMediaDeps {
  repo: MessageRepository;
  fileRepo: FileRepository;
  relay: LLMRelay;
  visionConfig: VisionConfig;
  /** 用于刷新失效的群文件下载 URL（经 P1 qq_action → OneBot get_group_file_url） */
  p1Client?: import("../../../common/ipc/client").IpcClient;
}

function isAudioName(name: string): boolean {
  const ext = "." + name.toLowerCase().split(".").pop()?.replace(/[?#].*$/, "");
  return AUDIO_EXT.has(ext);
}

function looksLikeAudioName(name: string): boolean {
  // 无扩展名或常见音频标记时，按文件名特征兜底
  return /\.(mp3|wav|flac|ogg|m4a|aac|wma|opus|amr|ape|silk|midi?)$/i.test(name);
}

function looksLikeTextName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = "." + name.slice(dot + 1).toLowerCase().replace(/[?#].*$/, "");
  return TEXT_EXT.has(ext);
}

function isVideoName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = "." + name.slice(dot + 1).toLowerCase().replace(/[?#].*$/, "");
  return VIDEO_EXT.has(ext) || isGifName(name);
}

function unsupportedLabelFor(name: string): { ext: string; desc: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = "." + name.slice(dot + 1).toLowerCase().replace(/[?#].*$/, "");
  if (UNSUPPORTED_DESC[ext]) return { ext, desc: UNSUPPORTED_DESC[ext] };
  return null;
}

/** 乱码/异常检测：含替换符或大量控制字符时判定为乱码 */
function hasGarbledText(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4096);
  // U+FFFD 替换符密度
  const replacement = (sample.match(/\uFFFD/g) ?? []).length;
  if (replacement > 0 && replacement / Math.max(sample.length, 1) > 0.01) {
    return true;
  }
  // 常见 mojibake 特征：Ã©Â 这类 UTF-8 被误读为 latin-1 的字节对
  if (/(Ã[\x80-\xbf]|Â[\x80-\xbf]|â€[™"œ])/.test(sample)) {
    return true;
  }
  return false;
}

async function downloadToTemp(url: string, suffix: string): Promise<string> {
  const tmp = `/tmp/amyluna-resolve-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}${suffix}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) {
    throw new Error(`download failed: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const fs = await import("node:fs");
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/** 经 P1 调 OneBot get_group_file_url 刷新失效的下载链接 */
async function refreshGroupFileUrl(
  deps: ResolveMediaDeps,
  groupId: number,
  fileId: string,
): Promise<string | null> {
  if (!deps.p1Client || !fileId) return null;
  try {
    const raw = await deps.p1Client.request("qq_action", {
      action: "get_group_file_url",
      params: { group_id: groupId, file_id: fileId },
    });
    const result = raw as { success?: boolean; result?: { url?: string }; error?: string } | null;
    if (result?.success && result?.result?.url) {
      log.info("resolveMedia.urlRefreshed", { group_id: groupId, hasUrl: true });
      return result.result.url;
    }
    log.warn("resolveMedia.urlRefreshFail", { group_id: groupId, error: result?.error ?? "no url" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("resolveMedia.urlRefreshError", { error: msg });
  }
  return null;
}

// ─── 分享卡片（json 段）解析辅助 ─────────────────────────────

/** 宽松解析 card_json：DB 存储可能把换行转义为字面 \n，需还原后再 parse */
function parseCardJson(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  const candidates = [raw, raw.replace(/\\n/g, "\n"), raw.replace(/\\\\/g, "\\")];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === "object") return obj as Record<string, any>;
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

/** 是否为网易云音乐分享卡：meta.music 存在且 musicUrl 指向 music.126.net / jumpUrl 指向 163 */
function isNeteaseMusicCard(card: Record<string, any> | null): boolean {
  if (!card) return false;
  const music = card.meta?.music;
  if (!music || typeof music !== "object") return false;
  const musicUrl = String(music.musicUrl ?? "");
  const jumpUrl = String(music.jumpUrl ?? "");
  const app = String(card.app ?? "");
  return musicUrl.includes("music.126.net") || jumpUrl.includes("music.163.com") || app.includes("music.lua");
}

/** 是否为 QQ 音乐分享卡：meta.music.musicUrl 指向 qqmusic 域名 / app 为 qqmusic */
function isQQMusicCard(card: Record<string, any> | null): boolean {
  if (!card) return false;
  const music = card.meta?.music;
  if (!music || typeof music !== "object") return false;
  const musicUrl = String(music.musicUrl ?? "");
  const jumpUrl = String(music.jumpUrl ?? "");
  const app = String(card.app ?? "");
  const prompt = String(card.prompt ?? "");
  return (
    musicUrl.includes("isure.stream.qqmusic.qq.com") ||
    musicUrl.includes("qqmusic") ||
    jumpUrl.includes("y.qq.com") ||
    app.includes("qqmusic") ||
    prompt.includes("QQ音乐")
  );
}

/** 从网易云/QQ音乐卡 meta.music 提取展示信息（歌名/歌手/描述） */
function extractMusicCardInfo(card: Record<string, any>): { title: string; singer: string } {
  const music = card.meta?.music ?? {};
  const prompt = String(card.prompt ?? "").replace(/^\[分享\]/, "").trim();
  const title = String(music.title ?? music.songname ?? prompt ?? "").trim();
  const singer = String(music.desc ?? music.singer ?? music.artist ?? "").trim();
  return { title, singer };
}

/** 调 media-analyzer /analyze 分析本地音频文件（供文件分支与卡片分支共用） */
async function callAudioAnalyzer(
  localPath: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const resp = await fetch(AUDIO_ANALYZER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: localPath, asr: true }),
      signal: AbortSignal.timeout(AUDIO_TIMEOUT_MS),
    });
    const data = (await resp.json()) as { ok?: boolean; text?: string; error?: string };
    if (!data.ok || !data.text) {
      return { ok: false, error: `音频分析失败: ${data.error ?? "未知错误"}` };
    }
    return { ok: true, text: data.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("resolveMedia.analyzerFail", { error: msg });
    return { ok: false, error: `媒体分析服务调用失败: ${msg}` };
  }
}

// ─── 标注回填辅助 ─────────────────────────────────────────────

/** 纯占位符形态（入库时生成的占位），只有这种 content 才允许被回填覆盖 */
const PLACEHOLDER_RE = /^\[(图片|视频|语音|文件|分享卡片|image|合并转发)\]$/;

/** 回填 content：仅当现有 content 是占位符时替换；超长截断 */
async function backfillContent(
  deps: ResolveMediaDeps,
  messageId: number,
  currentContent: string,
  newContent: string,
): Promise<void> {
  const cur = (currentContent ?? "").trim();
  if (!PLACEHOLDER_RE.test(cur)) {
    // 非占位符（用户正文/已回填过）不覆盖，避免破坏原文
    return;
  }
  const capped =
    newContent.length > CONTENT_BACKFILL_MAX
      ? newContent.slice(0, CONTENT_BACKFILL_MAX) + "\n…（解析内容较长，已截断）"
      : newContent;
  try {
    await deps.repo.updateContent(messageId, capped);
    log.info("resolveMedia.backfilled", { message_id: messageId, len: capped.length });
  } catch (err) {
    log.warn("resolveMedia.backfillFail", {
      message_id: messageId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 回填失败占位（图片/视频等解析失败时标注在 content 上，供引用侧看到失败状态） */
async function backfillFailure(
  deps: ResolveMediaDeps,
  messageId: number,
  currentContent: string,
  label: string,
  reason: string,
): Promise<void> {
  const cur = (currentContent ?? "").trim();
  if (PLACEHOLDER_RE.test(cur)) {
    try {
      await deps.repo.updateContent(messageId, `[${label}解析失败: ${reason.slice(0, 160)}]`);
    } catch {
      /* ignore */
    }
  }
}

export function createResolveMediaTool(deps: ResolveMediaDeps): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "resolve_media",
        description:
          "解析被引用的媒体/文件/分享卡片消息内容（图片、GIF、视频、音频文件/语音、文本文件、网易云/QQ音乐卡片）。" +
          "当用户引用（回复）了一条图片、GIF、视频、音频、文本文件或音乐分享卡片消息，而你在上下文中只看到 [图片] / [视频] / [文件] / [语音] / [分享卡片] 占位符时，" +
          "调用本工具传入被引用的消息 id（上下文引用前缀 (↳ MsgID:xxx) 中的 xxx），即可获得该媒体的解析结果。" +
          "图片与GIF返回视觉描述/时间轴；视频返回时间轴文字稿；音频（歌曲/语音）与音乐分享卡片返回声学特征、情绪判断与识别的歌词；" +
          "文本文件返回内容节选；其他类型返回文件名信息。解析结果会自动标注到该消息上，再次引用时无需重复解析。",
        parameters: {
          type: "object",
          properties: {
            message_id: {
              type: "integer",
              description:
                "被引用消息的 id（可为负），从上下文引用前缀 (↳ MsgID:xxx) 中取。主参数，解析 QQ 消息时必填。",
            },
            video_url: {
              type: "string",
              description:
                "可选。视频链接（文本里出现的 B站/直链 mp4 等 URL）。当用户直接给出链接而非引用消息时使用。",
            },
            video_path: {
              type: "string",
              description:
                "可选。服务器本地视频文件的绝对路径（如刚录制的摄像头视频）。仅当用户要求解析本机文件时使用。",
            },
          },
          required: ["message_id"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      // ── 入口：兼容三源（message_id 为主；video_url/video_path 为备用直连）──
      const midRaw = args.message_id ?? args.msg_id;
      const videoUrl = String(args.video_url ?? args.url ?? "").trim();
      const videoPath = String(args.video_path ?? args.path ?? "").trim();

      // 无 message_id、但给了链接/本机路径 → 直接走视频解析（不查库不标注）
      if (
        (midRaw === undefined || midRaw === null || String(midRaw).trim() === "") &&
        (videoUrl || videoPath)
      ) {
        const out = await analyzeVideoFromArgs(deps.repo, { video_url: videoUrl, video_path: videoPath });
        if (!out.ok) return { error: out.error ?? "视频解析失败" };
        return { content: out.content };
      }

      const messageId = Number(midRaw);
      if (!Number.isFinite(messageId)) {
        return { error: `无效的 message_id：${midRaw}` };
      }

      // 1. 查消息 + 查 group_files
      let stored;
      try {
        stored = await deps.repo.findByMessageId(messageId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `查询消息失败: ${msg}` };
      }
      if (!stored) {
        return { content: `未找到消息 ${messageId} 的入库记录，可能已过期或不在白名单群。请直接根据文字内容回复。` };
      }

      let fileRow = null;
      try {
        fileRow = await deps.fileRepo.findByMessageId(messageId);
      } catch (err) {
        log.error("resolveMedia.fileQueryFail", { message_id: messageId, error: String(err) });
      }

      const currentContent = stored.content ?? "";

      // ── 标注短路：content 已是回填的解析结果 → 直接返回标注，不再重复解析 ──
      // （标注工具语义：解析一次、引用即读；只有占位符/未回填才真正解析）
      const ANNOTATED_RE =
        /^【(视频解析结果|被引用图片解析|GIF解析|音频解析|文本文件解析|文件解析|分享音乐解析)/;
      if (ANNOTATED_RE.test(currentContent.trim())) {
        log.info("resolveMedia.annotatedHit", {
          message_id: messageId,
          len: currentContent.length,
        });
        return { content: currentContent };
      }

      // 2a. 图片（含 GIF 判定）：image_urls 有值
      const imageUrls: string[] = (() => {
        try {
          return JSON.parse(stored.image_urls ?? "[]") as string[];
        } catch {
          return [];
        }
      })();
      if (imageUrls.length > 0) {
        const gifUrl = imageUrls.find((u) => isGifUrl(u));
        if (gifUrl) {
          // ── GIF：下载 → 转 mp4 → 153 解析 ──
          log.info("resolveMedia.gif", { message_id: messageId });
          let gifPath = "";
          try {
            gifPath = await downloadGif(gifUrl);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await backfillFailure(deps, messageId, currentContent, "GIF", msg);
            return { error: `GIF 下载失败: ${msg}` };
          }
          try {
            const out = await analyzeGifFile(gifPath);
            if (!out.ok) {
              await backfillFailure(deps, messageId, currentContent, "GIF", out.error ?? "未知错误");
              return { error: out.error ?? "GIF 解析失败" };
            }
            await backfillContent(deps, messageId, currentContent, out.content ?? "");
            return { content: out.content };
          } finally {
            try {
              const fs = await import("node:fs");
              fs.unlinkSync(gifPath);
            } catch {
              /* ignore */
            }
          }
        }
        // ── 图片：vision 描述（30s 不重试）──
        log.info("resolveMedia.image", { message_id: messageId, imageCount: imageUrls.length });
        try {
          const description = await describeImages(imageUrls, deps.relay, deps.visionConfig);
          const content = `【被引用图片解析】\n${description}`;
          await backfillContent(deps, messageId, currentContent, content);
          return { content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await backfillFailure(deps, messageId, currentContent, "图片", msg);
          return { error: `图片解析失败: ${msg}` };
        }
      }

      // 2b. 分享卡片（json 段）：card_json 有值 → 解析卡片内容
      if (stored.card_json) {
        log.info("resolveMedia.card", { message_id: messageId });
        const card = parseCardJson(stored.card_json);

        // 音乐卡（网易云 / QQ音乐）：musicUrl 直链 → 下载试听 → 音频分析
        if (isNeteaseMusicCard(card) || isQQMusicCard(card)) {
          const music = card?.meta?.music ?? {};
          const musicUrl = String(music.musicUrl ?? "");
          const { title, singer } = extractMusicCardInfo(card!);
          if (!musicUrl) {
            return {
              content: `【分享音乐卡片】${title || "未知歌曲"}（${singer || "未知歌手"}）无可下载试听地址，无法解析。`,
            };
          }
          let localPath = "";
          try {
            log.info("resolveMedia.cardDownload", { message_id: messageId, title, singer });
            localPath = await downloadToTemp(musicUrl, ".mp3");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("resolveMedia.cardDownloadFail", { message_id: messageId, error: msg });
            return {
              error:
                `音乐试听文件下载失败（${msg}）。试听链接可能已过期，` +
                `可请用户重新分享该歌曲后再试。`,
            };
          }
          try {
            const res = await callAudioAnalyzer(localPath);
            if (!res.ok) return { error: res.error };
            const head = `【分享音乐解析】\n歌曲: ${title || "未知"}\n${singer ? `歌手/描述: ${singer}\n` : ""}\n`;
            const content = head + res.text;
            await backfillContent(deps, messageId, currentContent, content);
            return { content };
          } finally {
            try {
              const fs = await import("node:fs");
              if (localPath) fs.unlinkSync(localPath);
            } catch {
              // 忽略清理失败
            }
          }
        }

        // 其他分享卡片：先看是否视频卡（B站/抖音等）→ 自动转 video 解析
        const metaKeys = card?.meta ? Object.keys(card.meta) : [];
        const firstMeta: any = metaKeys.length > 0 ? card!.meta[metaKeys[0]] : null;
        const cardPrompt = String(card?.prompt ?? "").trim();
        const cardTitle = String(firstMeta?.title ?? firstMeta?.desc ?? cardPrompt ?? "").trim();
        const cardJump = String(
          firstMeta?.jumpUrl ?? firstMeta?.qqdocurl ?? card?.meta?.news?.jumpUrl ?? "",
        ).trim();
        const isVideoCard = /bilibili\.com|b23\.tv|youtube|youtu\.be|douyin|xiaohongshu|ixigua/i.test(
          cardJump + " " + cardTitle,
        );
        if (isVideoCard) {
          // 视频卡 → 用同一 message_id 走视频链路（卡片里自动挑链接）
          log.info("resolveMedia.card.video", { message_id: messageId });
          const out = await analyzeVideoFromArgs(deps.repo, { message_id: messageId });
          if (!out.ok) {
            await backfillFailure(deps, messageId, currentContent, "视频卡", out.error ?? "未知错误");
            return { error: out.error ?? "视频卡解析失败" };
          }
          await backfillContent(deps, messageId, currentContent, out.content ?? "");
          return { content: out.content };
        }
        const content =
          `【分享卡片】该分享暂不支持内容解析。\n` +
          `卡片标题: ${cardTitle.slice(0, 80) || "未知"}\n` +
          (cardJump ? `跳转链接: ${cardJump.slice(0, 200)}\n` : "");
        return { content };
      }

      // 3. 视频消息本体：video_urls 有值 → 153 解析
      const videoUrls = (stored.video_urls ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (videoUrls.length > 0) {
        log.info("resolveMedia.video", { message_id: messageId });
        const out = await analyzeVideoFromArgs(deps.repo, { message_id: messageId });
        if (!out.ok) {
          await backfillFailure(deps, messageId, currentContent, "视频", out.error ?? "未知错误");
          if (out.content) return { content: out.content };
          return { error: out.error ?? "视频解析失败" };
        }
        await backfillContent(deps, messageId, currentContent, out.content ?? "");
        return { content: out.content };
      }

      // 4. group_files 文件行
      if (fileRow) {
        const name = fileRow.file_name ?? "";

        // 4a. 视频/IF 文件 → 153 解析（用 message_id 走同一链路；GIF 交给 analyzeGifFile 需要链接，故直连 url）
        if (isVideoName(name)) {
          if (isGifName(name) && fileRow.url) {
            log.info("resolveMedia.file.gif", { message_id: messageId, file_name: name });
            let gifPath = "";
            try {
              gifPath = await downloadGif(fileRow.url);
              const out = await analyzeGifFile(gifPath);
              if (!out.ok) {
                await backfillFailure(deps, messageId, currentContent, "GIF", out.error ?? "未知错误");
                return { error: out.error ?? "GIF 解析失败" };
              }
              const content = `【GIF解析】${name}\n${out.content ?? ""}`;
              await backfillContent(deps, messageId, currentContent, content);
              try {
                await deps.fileRepo.updateAnalysisStatus(messageId, "done");
              } catch {
                /* ignore */
              }
              return { content };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await backfillFailure(deps, messageId, currentContent, "GIF", msg);
              return { error: `GIF 解析失败: ${msg}` };
            } finally {
              try {
                const fs = await import("node:fs");
                if (gifPath) fs.unlinkSync(gifPath);
              } catch {
                /* ignore */
              }
            }
          }
          log.info("resolveMedia.file.video", { message_id: messageId, file_name: name });
          const out = await analyzeVideoFromArgs(deps.repo, { message_id: messageId });
          if (!out.ok) {
            await backfillFailure(deps, messageId, currentContent, "视频", out.error ?? "未知错误");
            if (out.content) return { content: out.content };
            return { error: out.error ?? "视频解析失败" };
          }
          await backfillContent(deps, messageId, currentContent, out.content ?? "");
          try {
            await deps.fileRepo.updateAnalysisStatus(messageId, "done");
          } catch {
            /* ignore */
          }
          return { content: out.content };
        }

        // 4b. 占位类型（pdf/zip/exe 等未实现）→ 结构化占位 + 回填
        const unsup = unsupportedLabelFor(name);
        if (unsup) {
          log.info("resolveMedia.unsupported", { message_id: messageId, file_name: name, ext: unsup.ext });
          const content =
            `【文件解析】${name}\n` +
            `大小: ${fileRow.file_size ?? "?"} 字节\n` +
            `（该类型为${unsup.desc}，暂不支持内容解析；如需可告知用户下载查看）`;
          await backfillContent(deps, messageId, currentContent, content);
          try {
            await deps.fileRepo.updateAnalysisStatus(messageId, "failed"); // 未实现 → 标记 failed 占位
          } catch {
            /* ignore */
          }
          return { content };
        }

        const url = fileRow.url ?? "";

        // 4c. 文本：/extract-text
        if (looksLikeTextName(name)) {
          if (!url) {
            return { error: `文件 ${name} 无下载地址（url 可能已过期），无法解析。` };
          }
          let localPath = "";
          const suffix = "." + (name.split(".").pop() || "bin");
          let activeUrl = url;
          try {
            localPath = await downloadToTemp(activeUrl, suffix);
          } catch (err) {
            const firstErr = err instanceof Error ? err.message : String(err);
            const freshUrl = await refreshGroupFileUrl(deps, fileRow.group_id, fileRow.file_id);
            if (freshUrl && freshUrl !== activeUrl) {
              activeUrl = freshUrl;
              try {
                localPath = await downloadToTemp(activeUrl, suffix);
              } catch {
                /* keep firstErr */
              }
            }
            if (!localPath) {
              return { error: `文件下载失败（${firstErr}）。下载链接可能已过期且刷新失败；可请用户重新发送文件。` };
            }
          }
          try {
            const resp = await fetch(TEXT_EXTRACT_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: localPath }),
              signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
            });
            const data = (await resp.json()) as {
              ok?: boolean;
              is_binary?: boolean;
              encoding?: string;
              text?: string;
              truncated?: boolean;
              file_size?: number;
              error?: string;
            };
            if (!data.ok) {
              return { error: `文本提取失败: ${data.error ?? "未知错误"}` };
            }
            if (data.is_binary) {
              return {
                content:
                  `【文本文件解析】${name}\n` +
                  `（文件为二进制（实际编码: ${data.encoding}），无法按文本读取。）`,
              };
            }
            if (data.text && hasGarbledText(data.text)) {
              return {
                content:
                  `【文本文件解析】${name}\n内容疑似乱码（编码不匹配），无法正常读取。可尝试用其他工具/软件打开查看。`,
              };
            }
            const content =
              `【文本文件解析】${name}\n` +
              `大小: ${data.file_size ?? "?"} 字节\n` +
              `截断: ${data.truncated ? "是（内容过长，显示前 5KB + 后 5KB）" : "否（全文）"}\n\n` +
              `== 内容 ==\n${data.text ?? "(空)"}`;
            await backfillContent(deps, messageId, currentContent, content);
            try {
              await deps.fileRepo.updateAnalysisStatus(messageId, "done");
            } catch {
              /* ignore */
            }
            return { content };
          } finally {
            try {
              const fs = await import("node:fs");
              if (localPath) fs.unlinkSync(localPath);
            } catch {
              /* ignore */
            }
          }
        }

        // 4d. 音频：调 /analyze
        if (isAudioName(name) || looksLikeAudioName(name)) {
          if (!url) {
            return { error: `文件 ${name} 无下载地址（url 可能已过期），无法解析。` };
          }
          let localPath = "";
          const suffix = "." + (name.split(".").pop() || "mp3");
          let activeUrl = url;
          try {
            localPath = await downloadToTemp(activeUrl, suffix);
          } catch (err) {
            const firstErr = err instanceof Error ? err.message : String(err);
            const freshUrl = await refreshGroupFileUrl(deps, fileRow.group_id, fileRow.file_id);
            if (freshUrl && freshUrl !== activeUrl) {
              activeUrl = freshUrl;
              try {
                localPath = await downloadToTemp(activeUrl, suffix);
              } catch {
                /* keep firstErr */
              }
            }
            if (!localPath) {
              return { error: `文件下载失败（${firstErr}）。下载链接可能已过期且刷新失败；可请用户重新发送文件。` };
            }
          }
          try {
            log.info("resolveMedia.audio", { message_id: messageId, file_name: name });
            const audioRes = await callAudioAnalyzer(localPath);
            if (!audioRes.ok) return { error: audioRes.error };
            const content = `【音频解析】${name}\n${audioRes.text}`;
            await backfillContent(deps, messageId, currentContent, content);
            try {
              await deps.fileRepo.updateAnalysisStatus(messageId, "done");
            } catch {
              /* ignore */
            }
            return { content };
          } finally {
            try {
              const fs = await import("node:fs");
              if (localPath) fs.unlinkSync(localPath);
            } catch {
              // 忽略清理失败
            }
          }
        }

        // 4e. 非音频非文本非视频非占位（未知扩展名）→ 返回文件名信息
        return {
          content:
            `【被引用文件】\n文件名: ${name}\n大小: ${fileRow.file_size ?? "?"} 字节\n` +
            `状态: ${fileRow.download_status}\n（该文件类型暂不支持内容解析，如需可告知用户下载查看）`,
        };
      }

      // 5. 无媒体附件 → 直读文字
      const contentSnippet = (stored.content ?? "").slice(0, 120);
      return {
        content: `消息 ${messageId} 无媒体附件可解析（内容: ${contentSnippet || "空"}）。请直接根据文字内容回复。`,
      };
    },
    requiresFollowUp: true,
    timeout: 310000, // 视频最坏情况（下载 3min + 解析 5min 内由 media-video 内部超时兜底）；LLM 侧总超时更大
    resultMaxLength: 8000,
  };
}