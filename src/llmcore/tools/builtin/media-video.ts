/**
 * media-video.ts — 视频/GIF 解析辅助模块（原 analyze_video 逻辑移植）。
 *
 * 能力并入 resolve_media 后不再单独注册工具，本模块仅提供：
 *   - resolveVideoSource(): 从消息/链接/本机路径取到本地视频文件
 *   - uploadToVlm(): 上传字节到 153 vlm-api 得时间轴 JSON
 *   - analyzeVideoFromArgs(): 三源合一 → 解析 → 返回组装好的 content（供 resolve-media 回填）
 *   - transcodeGifToMp4(): GIF → mp4（153 抽帧链路要求视频输入）
 *
 * 设计要点：
 *   - 解析工作全部在 153 完成，本模块只负责「取文件 + 搬运 + 时间轴清洗」。
 *   - 下载来的视频落 /tmp，解析完立即删除，不持久化。
 *   - 153 侧模型闲置 20 分钟自动停，首次请求冷启动（+30~40s），cold_start=true 属正常。
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { MessageRepository, StoredMessage } from "../../../common/db/message-repository";
import { createLogger } from "../../../common/logger";

const execFileAsync = promisify(execFile);

const log = createLogger("P3.tools");

const VLM_API = "http://192.168.31.153:8644";
const REQUEST_TIMEOUT_MS = 300000; // 冷启动 + 30~60 帧解析，留足 5 分钟
const DOWNLOAD_TIMEOUT_MS = 180000; // 下载 / yt-dlp 抽流 3 分钟
const MAX_UPLOAD_MB = 512;
const HTTP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** yt-dlp 由 pipx 装在 ~/.local/bin，pm2 进程 PATH 未必含它，故写死兜底路径 */
const YTDLP_BIN = process.env.YTDLP_BIN || path.join(os.homedir(), ".local", "bin", "yt-dlp");

export interface AnalyzeVideoArgs {
  /** QQ 视频消息 / 视频分享卡片（取 MsgID） */
  message_id?: number | null;
  /** 文本里出现的视频链接 */
  video_url?: string | null;
  /** 服务器本地视频文件路径 */
  video_path?: string | null;
  /** 抽帧率，默认 1 */
  fps?: number;
}

export interface VideoAnalyzeOutcome {
  ok: boolean;
  content?: string;
  error?: string;
  /** 来源描述（用于回填时标注），如 "QQ 消息 xxx 的视频" */
  sourceDesc?: string;
}

/** 处理 ~ 与引号，转绝对路径 */
function expandPath(p: string): string {
  let s = p.trim().replace(/^["']+|["']+$/g, "");
  if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(s);
}

/** 从 URL 猜扩展名，猜不出给 .mp4 */
function guessSuffix(url: string): string {
  try {
    const p = new URL(url).pathname.toLowerCase();
    const m = p.match(/\.(mp4|mov|m4v|mkv|webm|flv|avi|ts|3gp)$/);
    if (m) return `.${m[1]}`;
  } catch {
    /* URL 非法时走默认 */
  }
  return ".mp4";
}

/** 直链判定：扩展名命中，或（无扩展名的）QQ 文件托管域 */
function isDirectLink(url: string): boolean {
  if (/\.(mp4|mov|m4v|mkv|webm|flv|avi|ts|3gp)(\?|#|$)/i.test(url)) return true;
  try {
    const host = new URL(url).host.toLowerCase();
    if (/(^|\.)(multimedia\.nt\.qq\.com\.cn|ftn\.qq\.com)$/.test(host)) return true;
  } catch {
    /* 非法 URL 交 yt-dlp 试 */
  }
  return false;
}

/** 视频站点特征（这些链接交 yt-dlp 抽流） */
const VIDEO_HOST_RE =
  /(b23\.tv\/|bilibili\.com\/video\/|youtube\.com\/watch|youtu\.be\/|douyin\.com\/|v\.douyin\.com\/|weibo\.com\/tv\/|xiaohongshu\.com\/|ixigua\.com\/)/i;
const URL_RE = /https?:\/\/[^\s"'\\<>)\]]+/g;

/** 从一段文本里挑视频链接：先站点链接，再直链；挑不出返回 null */
function pickUrl(text: string): string | null {
  if (!text) return null;
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) if (VIDEO_HOST_RE.test(u)) return u;
  for (const u of urls) if (isDirectLink(u)) return u;
  return null;
}

/** 从卡片 JSON（B站/视频分享卡）里挑视频链接：遍历全部字符串值 */
function pickUrlFromJson(json: string | null | undefined): string | null {
  if (!json) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return pickUrl(json.replace(/\\\//g, "/"));
  }
  const found: string[] = [];
  const walk = (o: unknown): void => {
    if (typeof o === "string") {
      const m = pickUrl(o);
      if (m) found.push(m);
    } else if (Array.isArray(o)) {
      o.forEach(walk);
    } else if (o && typeof o === "object") {
      Object.values(o as Record<string, unknown>).forEach(walk);
    }
  };
  walk(obj);
  return found.find((u) => VIDEO_HOST_RE.test(u)) ?? found[0] ?? null;
}

/** 直接下载字节（QQ 视频 url、直链 mp4 等），返回本地临时文件路径 */
async function downloadHttp(url: string, suffix: string): Promise<string> {
  log.info("mediaVideo.download", { url: url.slice(0, 100) });
  const resp = await fetch(url, {
    headers: { "User-Agent": HTTP_UA },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const tmp = path.join(
    os.tmpdir(),
    `media_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${suffix}`,
  );
  fs.writeFileSync(tmp, buf);
  return tmp;
}

/** 站点链接（B站等）交 yt-dlp 抽流下载，返回本地文件路径（由 --print after_move:filepath 给出） */
async function downloadWithYtdlp(url: string): Promise<string> {
  log.info("mediaVideo.ytdlp", { url: url.slice(0, 100), bin: YTDLP_BIN });
  const base = path.join(
    os.tmpdir(),
    `media_video_yt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  const args = [
    "--no-playlist",
    "--max-filesize",
    `${MAX_UPLOAD_MB}M`,
    "-f",
    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
    "--merge-output-format",
    "mp4",
    "--no-progress",
    "--print",
    "after_move:filepath",
    "-o",
    `${base}.%(ext)s`,
    url,
  ];
  let stdout = "";
  try {
    const r = await execFileAsync(YTDLP_BIN, args, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = r.stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").toString().trim().slice(-400);
    throw new Error(`yt-dlp 失败：${detail}`);
  }
  const out = stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  if (!out || !fs.existsSync(out)) throw new Error(`yt-dlp 未产出文件（输出：${stdout.slice(-300)}）`);
  return out;
}

/** GIF → mp4（libx264 转封装，保持原帧序列；153 抽帧链路按视频处理） */
async function transcodeGifToMp4(gifPath: string): Promise<string> {
  const out = path.join(
    os.tmpdir(),
    `media_gif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`,
  );
  log.info("mediaVideo.gifTranscode", { src: gifPath.slice(-40), out: out.slice(-40) });
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      gifPath,
      "-movflags",
      "+faststart",
      "-pix_fmt",
      "yuv420p",
      "-vf",
      "scale=768:-2:flags=lanczos,fps=1",
      out,
    ], { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const detail = (e.stderr || e.message || "").toString().trim().slice(-400);
    throw new Error(`GIF 转 mp4 失败：${detail}`);
  }
  if (!fs.existsSync(out)) throw new Error("GIF 转 mp4 未产出文件");
  return out;
}

/** 上传本地文件字节到 153 vlm-api /analyze，返回解析 JSON（含时间轴） */
async function uploadToVlm(localPath: string, fps: number): Promise<Record<string, unknown>> {
  const sizeMb = fs.statSync(localPath).size / 1048576;
  if (sizeMb > MAX_UPLOAD_MB) {
    throw new Error(`文件 ${sizeMb.toFixed(1)}MB 超过上限 ${MAX_UPLOAD_MB}MB`);
  }
  const body = fs.readFileSync(localPath);
  const resp = await fetch(`${VLM_API}/analyze?fps=${fps}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await resp.text();
  if (!resp.ok) {
    log.warn("mediaVideo.http", { status: resp.status });
    throw new Error(`解析服务返回 HTTP ${resp.status}：${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** 从时间轴 JSON 组装返回给主模型的内容（含覆盖度提醒） */
function composeResult(sourceDesc: string, d: Record<string, unknown>, fps: number): string {
  const segments = d.segments as Array<Record<string, unknown>> | null | undefined;
  const durationS = Number(d.duration_s) || 0;
  const frames = Number(d.frames) || 0;
  const covered = frames / fps;
  const truncated = durationS > 0 && covered + 2 < durationS;
  const compact = {
    duration_s: d.duration_s,
    fps: d.fps,
    frames: d.frames,
    cold_start: !!d.cold_start,
    segments: segments ?? null,
    timeline_raw: segments ? undefined : d.timeline_raw,
  };
  log.info("mediaVideo.done", {
    source: sourceDesc,
    frames,
    segments: Array.isArray(segments) ? segments.length : 0,
    coldStart: !!d.cold_start,
  });
  return (
    `【视频解析结果（由 153 的本地视觉模型生成，来源：${sourceDesc}，时长 ${d.duration_s}s，抽帧 ${d.frames} 帧` +
    (d.cold_start ? "，模型本次为冷启动" : "") +
    `）】\n` +
    JSON.stringify(compact, null, 1) +
    (truncated
      ? `\n\n注意：视频较长（${durationS}s），本次只覆盖了开头约 ${Math.round(covered)} 秒的画面，可告知用户如需完整覆盖可分段再解析。`
      : "") +
    `\n\n请据此用中文自然语言向用户讲述这段视频的过程（按时间顺序，突出变化），不要把 JSON 原样贴给用户。`
  );
}

/**
 * 从 QQ 消息取视频源（附件 > 卡片/正文链接 > 同群就近一条带视频的消息）。
 * 返回 { source, fromLink, sourceDesc }，取不到则 null。
 */
async function resolveSourceFromMessage(
  repo: MessageRepository,
  stored: StoredMessage,
): Promise<{ source: string; fromLink: boolean; sourceDesc: string } | null> {
  const urls = (stored.video_urls ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (urls[0]) {
    return { source: urls[0], fromLink: false, sourceDesc: `QQ 消息 ${stored.message_id} 的视频` };
  }
  const ownLink = pickUrlFromJson(stored.card_json) ?? pickUrl(stored.content ?? "");
  if (ownLink) {
    return { source: ownLink, fromLink: true, sourceDesc: `QQ 消息 ${stored.message_id} 里的视频链接` };
  }
  // 兜底：用户只说「看看这个视频」时，模型可能把那条说话消息的 id 传了进来
  try {
    const near = await repo.findRecentBeforeRow(stored.group_id, stored.id, 8);
    for (const m of near) {
      const vid = (m.video_urls ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (vid) {
        return {
          source: vid,
          fromLink: false,
          sourceDesc: `同群最近一条视频消息 ${m.message_id ?? "?"}（本条无视频，已就近回退）`,
        };
      }
      const l = pickUrlFromJson(m.card_json) ?? pickUrl(m.content ?? "");
      if (l) {
        return {
          source: l,
          fromLink: true,
          sourceDesc: `同群最近一条视频卡片/链接消息 ${m.message_id ?? "?"}（本条无视频，已就近回退）`,
        };
      }
    }
  } catch (err) {
    log.warn("mediaVideo.nearbyFail", { message_id: stored.message_id, error: String(err) });
  }
  return null;
}

/**
 * 三源合一解析视频：message_id（QQ 视频消息/卡片）或 video_url（直链/站点）或 video_path（本机）。
 * 成功后返回组装好的 content；失败返回 error。
 */
export async function analyzeVideoFromArgs(
  repo: MessageRepository,
  args: AnalyzeVideoArgs,
): Promise<VideoAnalyzeOutcome> {
  const fps = Number(args.fps) > 0 ? Number(args.fps) : 1;
  let localPath: string | null = null;
  let downloaded = false;
  let sourceDesc = "";

  try {
    const rawPath = String(args.video_path ?? "").trim();
    const rawUrl = String(args.video_url ?? "").trim();
    const midRaw = args.message_id;

    if (rawPath) {
      // ── 本机文件 ──
      localPath = expandPath(rawPath);
      if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
        return { ok: false, error: `文件不存在或不是文件：${localPath}` };
      }
      sourceDesc = `本地文件 ${path.basename(localPath)}`;
    } else if (midRaw !== undefined && midRaw !== null && String(midRaw).trim() !== "") {
      // ── QQ 视频消息 ──
      const messageId = Number(midRaw);
      if (!Number.isFinite(messageId)) return { ok: false, error: `无效的 message_id：${midRaw}` };
      let stored: StoredMessage | null;
      try {
        stored = await repo.findByMessageId(messageId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `查询消息失败：${msg}` };
      }
      if (!stored) {
        return { ok: false, content: `未找到消息 ${messageId} 的入库记录，可能已过期或不在白名单群。` };
      }
      const src = await resolveSourceFromMessage(repo, stored);
      if (!src) {
        return { ok: false, content: `消息 ${messageId} 上没有视频附件，也没找到视频链接（可能不是视频消息）。` };
      }
      sourceDesc = src.sourceDesc;
      try {
        if (src.fromLink && !isDirectLink(src.source)) {
          localPath = await downloadWithYtdlp(src.source);
        } else {
          localPath = await downloadHttp(src.source, guessSuffix(src.source));
        }
        downloaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("mediaVideo.msgDownloadFail", { message_id: messageId, error: msg });
        return {
          ok: false,
          error:
            `获取该消息的视频失败（${msg}）。QQ 视频链接有时效，过期后无法再取，` +
            `可请用户重新发一次视频/链接再解析。`,
        };
      }
    } else if (rawUrl) {
      // ── 视频链接 ──
      try {
        if (isDirectLink(rawUrl)) {
          localPath = await downloadHttp(rawUrl, guessSuffix(rawUrl));
        } else {
          localPath = await downloadWithYtdlp(rawUrl);
        }
        downloaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("mediaVideo.urlDownloadFail", { url: rawUrl.slice(0, 120), error: msg });
        return { ok: false, error: `下载视频链接失败（${msg}）。若是站点链接，可能是链接失效或该站点暂不支持。` };
      }
      sourceDesc = `链接 ${rawUrl.slice(0, 80)}`;
    } else {
      return { ok: false, error: "缺少参数：请提供 message_id、video_url 或 video_path 之一。" };
    }

    const d = await uploadToVlm(localPath, fps);
    const content = composeResult(sourceDesc, d, fps);
    return { ok: true, content, sourceDesc };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("mediaVideo.fail", { source: sourceDesc, error: msg });
    if (/ECONNREFUSED|fetch failed|timed out|timeout/i.test(msg)) {
      return {
        ok: false,
        error:
          `连不上解析服务 ${VLM_API}（${msg}）。该服务在 153（192.168.31.153）上，可先确认：` +
          `curl -s http://192.168.31.153:8644/admin/status`,
      };
    }
    return { ok: false, error: `解析失败：${msg}` };
  } finally {
    if (downloaded && localPath) {
      try {
        fs.unlinkSync(localPath);
      } catch {
        /* 清理失败不影响结果 */
      }
    }
  }
}

/** GIF 文件 → 转 mp4 → 153 解析，返回与视频一致的内容 */
export async function analyzeGifFile(gifPath: string): Promise<VideoAnalyzeOutcome> {
  let mp4: string | null = null;
  try {
    mp4 = await transcodeGifToMp4(gifPath);
    const d = await uploadToVlm(mp4, 1);
    const content = composeResult(`GIF 动画（已转 mp4，${path.basename(gifPath)}）`, d, 1);
    return { ok: true, content, sourceDesc: `GIF 动画 ${path.basename(gifPath)}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("mediaVideo.gifFail", { error: msg });
    return { ok: false, error: `GIF 解析失败：${msg}` };
  } finally {
    if (mp4) {
      try {
        fs.unlinkSync(mp4);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 判断文件名是否为 GIF（供判型使用） */
export function isGifName(name: string): boolean {
  return /\.gif$/i.test(name.trim());
}

/** 判断 URL 是否为 GIF 直链 */
export function isGifUrl(url: string): boolean {
  return /\.gif(\?|#|$)/i.test(url);
}

/** GIF URL → 下载临时文件（供 gif handler 使用） */
export async function downloadGif(url: string): Promise<string> {
  return downloadHttp(url, ".gif");
}