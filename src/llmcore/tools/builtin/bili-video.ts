/**
 * search_bili_video / send_bili_card 工具 — QQ 群 B站视频点播。
 *
 * 多轮交互设计（与 song-search/song-send 同构）：
 *   第一轮 search_bili_video(关键词) → 返回候选列表（≤8 条，含标题/UP主/播放/时长/bvid）
 *   第二轮 send_bili_card(群号, bvid) → 发可点开的 B站分享卡到群
 *
 * 发送机制（2026-09-04 本机实测定论，见技能 qq-onebot-bot
 * references/bilibili-card-autonomous-construct.md）：
 *   SnowLuma getMiniAppArk 封装残缺(6/19 字段) → 服务端不登记 → 点开"已下架"；
 *   必须走 SnowLuma HTTP /send_packet 原始通道，手工补全 NapCat 同款 19 字段
 *   protobuf（含 versionId=cfc5f7b05b44b5956502edaecf9d2240、time 当前毫秒）→
 *   服务端登记 → 返回 jsonStr {appName/appView/ver/metaData/config} → 组
 *   OneBot json 段 POST /send_group_msg → 卡可点开（与真人转发一致）。
 *   全程 HTTP 直连 SnowLuma（Bearer token 经 loadConfig 从 .env 取，不落新文件）。
 *
 * B站搜索接口经验（2026-09-05 实测）：
 *   - x/web-interface/search/type?search_type=video 无需登录即可用；
 *     但先 GET www.bilibili.com 首页拿 buvid3 Cookie 更稳（无 Cookie 可能被 412 HTML 拦）
 *   - 结果 title 含 <em> 标签需剥；is_charge_video/badgepay=充电视频须过滤（点开要钱）
 */

import type { ToolMeta } from "../types";
import { loadConfig } from "../../../common/config";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools.bili");

// ── B站搜索 ──
const BILI_HOME = "https://www.bilibili.com/";
const BILI_SEARCH_URL = "https://api.bilibili.com/x/web-interface/search/type";
const SEARCH_TIMEOUT_MS = 15000;
const MAX_SEARCH_RETRY = 2;
const CANDIDATE_LIMIT = 8;
const BILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── 发卡常量（与技能 scripts/bili_ark_send.py 同款）──
const BILI_APPID = "1109937557";
const BILI_VERSION_ID = "cfc5f7b05b44b5956502edaecf9d2240";
const BILI_ICON =
  "https://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg";
const SDK_ID = "V1_PC_MINISDK_99.99.99_1_APP_A";
const ADAPT_CMD = "LightAppSvc.mini_app_share.AdaptShareInfo";

/** 候选视频信息（第二步发卡只需 aid/title/pic） */
interface BiliCandidateMeta {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  author: string;
  play: string;
  duration: string;
}

/** 进程内候选缓存：search_bili_video 存入，send_bili_card 取出（P3 单实例，重启丢失无妨） */
const candidateCache = new Map<string, BiliCandidateMeta>();
const CACHE_MAX = 200;

// ── protobuf wire 编码（对照 python 版）──────────────────────────

function varint(n: bigint): Buffer {
  const out: number[] = [];
  for (;;) {
    const b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) out.push(b | 0x80);
    else {
      out.push(b);
      return Buffer.from(out);
    }
  }
}

function tag(field: number, wire: number): Buffer {
  return varint(BigInt((field << 3) | wire));
}

function fStr(field: number, s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([tag(field, 2), varint(BigInt(b.length)), b]);
}

function fUint(field: number, n: bigint): Buffer {
  return Buffer.concat([tag(field, 0), varint(n)]);
}

function fBytes(field: number, b: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(BigInt(b.length)), b]);
}

function fMsg(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(BigInt(payload.length)), payload]);
}

/** 构造 NapCat 同款 19 字段 MiniAppShareReq(hex) */
export function buildBiliReq(
  title: string,
  desc: string,
  picUrl: string,
  jumpUrl: string,
  tsMs: number,
): string {
  const inner = Buffer.concat([
    fMsg(1, fBytes(2, Buffer.alloc(0))), // extInfo { field2: bytes空 }
    fStr(2, BILI_APPID),
    fStr(3, title),
    fStr(4, desc),
    fUint(5, BigInt(tsMs)),
    fUint(6, 1n),
    fUint(7, 1n),
    fUint(8, 0n),
    fStr(9, picUrl),
    fStr(10, ""),
    fStr(11, jumpUrl),
    fStr(12, BILI_ICON),
    fUint(13, 3n),
    fUint(14, 0n),
    fStr(15, BILI_VERSION_ID),
    fUint(16, 0n),
    fStr(17, ""),
    fBytes(18, Buffer.alloc(0)),
    fMsg(19, Buffer.concat([fStr(1, ""), fStr(2, "")])),
    fStr(20, ""),
  ]);
  const outer = Buffer.concat([fStr(2, SDK_ID), fMsg(4, inner)]);
  return outer.toString("hex");
}

function readVarint(buf: Buffer, i: number): { v: bigint; i: number } {
  let t = 0n;
  let sh = 0n;
  for (;;) {
    const b = buf[i];
    i += 1;
    t |= BigInt(b & 0x7f) << sh;
    sh += 7n;
    if (!(b & 0x80)) return { v: t, i };
  }
}

/** send_packet 响应 hex -> 外层 field4(body) -> 内层 field2(jsonStr) */
export function parseBiliJsonStr(hexResp: string): string | null {
  const rb = Buffer.from(hexResp, "hex");
  let idx = 0;
  while (idx < rb.length) {
    const { v: t, i: i1 } = readVarint(rb, idx);
    idx = i1;
    const field = Number(t >> 3n);
    const wire = Number(t & 7n);
    if (wire === 2) {
      const { v: l, i: i2 } = readVarint(rb, idx);
      idx = i2;
      const payload = rb.subarray(idx, idx + Number(l));
      idx += Number(l);
      if (field === 4) {
        let j = 0;
        while (j < payload.length) {
          const { v: t2, i: j1 } = readVarint(payload, j);
          j = j1;
          const f2 = Number(t2 >> 3n);
          const w2 = Number(t2 & 7n);
          if (w2 === 2) {
            const { v: l2, i: j2 } = readVarint(payload, j);
            j = j2;
            const p2 = payload.subarray(j, j + Number(l2));
            j += Number(l2);
            if (f2 === 2) return p2.toString("utf8");
          } else if (w2 === 0) {
            const { i: j3 } = readVarint(payload, j);
            j = j3;
          } else if (w2 === 5) {
            j += 4;
          } else if (w2 === 1) {
            j += 8;
          } else {
            break;
          }
        }
      }
    } else if (wire === 0) {
      const { i: i3 } = readVarint(rb, idx);
      idx = i3;
    } else if (wire === 5) {
      idx += 4;
    } else if (wire === 1) {
      idx += 8;
    } else {
      break;
    }
  }
  return null;
}

// ── SnowLuma HTTP 调用（Bearer token 经 loadConfig 从 .env 取，模块级缓存）──────

let cachedSnowlumaToken: string | null = null;

function snowlumaToken(): string {
  if (cachedSnowlumaToken === null) {
    const cfg = loadConfig();
    // HTTP 通道用 httpServers 的 accessToken（与 WS 的 token 不同，见 .env SNOWLUMA_HTTP_ACCESS_TOKEN）
    cachedSnowlumaToken = cfg.snowluma.httpAccessToken || cfg.snowluma.accessToken || "";
  }
  return cachedSnowlumaToken;
}

async function postSnowLuma(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = snowlumaToken();
  const base = process.env.BILI_SL_HTTP_URL || "http://127.0.0.1:3000";
  const resp = await fetch(base + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`SnowLuma HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

// ── B站搜索（先 GET 首页拿 buvid3 Cookie）────────────────────────

async function fetchBuvid3Cookie(): Promise<string> {
  const resp = await fetch(BILI_HOME, {
    headers: { "User-Agent": BILI_UA },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    redirect: "follow",
  });
  const headers = resp.headers as unknown as { getSetCookie?: () => string[] };
  let cookies: string[] = [];
  if (typeof headers.getSetCookie === "function") {
    cookies = headers.getSetCookie();
  } else {
    const sc = resp.headers.get("set-cookie");
    if (sc) cookies = [sc];
  }
  return cookies
    .filter((c) => /^(buvid3|b_nut)=/.test(c.trim()))
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function httpBiliSearch(keyword: string): Promise<Array<Record<string, unknown>>> {
  const cookie = await fetchBuvid3Cookie();
  const url = new URL(BILI_SEARCH_URL);
  url.searchParams.set("search_type", "video");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("page", "1");
  const resp = await fetch(url.toString(), {
    headers: {
      "User-Agent": BILI_UA,
      Referer: "https://www.bilibili.com/",
      ...(cookie ? { Cookie: cookie } : {}),
      Accept: "application/json, text/plain, */*",
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`B站搜索 HTTP ${resp.status}`);
  const data = (await resp.json()) as {
    code?: number;
    message?: string;
    data?: { result?: unknown };
  };
  if (data.code !== 0) {
    throw new Error(`B站搜索 code=${data.code} ${data.message ?? ""}`);
  }
  const result = data.data?.result;
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : [];
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").trim();
}

/** // 开头封面补 https: */
function normalizePic(pic: unknown): string {
  const s = String(pic ?? "");
  if (s.startsWith("//")) return "https:" + s;
  return s;
}

async function biliSearchWithRetry(keyword: string): Promise<BiliCandidateMeta[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_SEARCH_RETRY; attempt++) {
    try {
      const items = await httpBiliSearch(keyword);
      const picked: BiliCandidateMeta[] = [];
      for (const it of items) {
        if (picked.length >= CANDIDATE_LIMIT) break;
        // 过滤：充电视频、直播、无有效 bvid/aid
        if (it.is_charge_video || it.badgepay || it.live_status) continue;
        const bvid = String(it.bvid ?? "");
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) continue;
        const aid = Number(it.aid);
        const title = stripHtml(String(it.title ?? "")).slice(0, 80);
        if (!aid || !title) continue;
        const meta: BiliCandidateMeta = {
          bvid,
          aid,
          title,
          pic: normalizePic(it.pic),
          author: String(it.author ?? it.uname ?? "").slice(0, 30),
          play: String(it.play ?? ""),
          duration: String(it.duration ?? ""),
        };
        picked.push(meta);
        if (candidateCache.size >= CACHE_MAX) {
          const first = candidateCache.keys().next().value;
          if (first) candidateCache.delete(first);
        }
        candidateCache.set(bvid, meta);
      }
      if (picked.length > 0) return picked;
      lastErr = new Error("搜索结果为空（可能被风控或关键词无结果）");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      log.warn("biliSearch.retry", { attempt: attempt + 1, error: lastErr.message });
    }
    if (attempt < MAX_SEARCH_RETRY) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("B站搜索失败");
}

function formatBiliCandidates(list: BiliCandidateMeta[], keyword: string): string {
  const lines = list.map(
    (m, i) => `${i + 1}. ${m.title} — ${m.author}（播放:${m.play}｜时长:${m.duration}｜bvid=${m.bvid}）`,
  );
  return [
    `【B站搜索】关键词「${keyword}」共 ${list.length} 条候选（已过滤充电/直播）：`,
    ...lines,
    "",
    "请根据用户意图（视频标题、UP主、版本）判断选哪条：",
    "能明确确定 → 调用 send_bili_card(群号, bvid) 直接发送可点开的B站视频卡到群；",
    "拿不准（候选都不太像、需要更具体信息）→ 可向用户说明并询问，不要乱发。",
  ].join("\n");
}

// ====== 工具一：search_bili_video ======

export function createBiliSearchTool(): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "search_bili_video",
        description:
          "搜索B站视频，返回候选列表（含序号/标题/UP主/播放/时长/bvid）。" +
          "当用户要求找/点播某个B站视频、报出视频标题、或想发B站视频到群里时，调用本工具传入关键词即可获得候选。" +
          "返回后请结合用户意图判断：确定选哪条就调用 send_bili_card(群号, bvid) 把可点开的B站分享卡发到群；" +
          "拿不准（候选不匹配/用户描述不清）可询问用户更具体的信息。注意：听歌点歌用 search_song，本工具只负责B站视频。",
        parameters: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description:
                "搜索关键词：用户提到的视频标题/主题/UP主，尽量精确（如 '罗小黑战记 剧场版'、'华为发布会'）。可含空格，系统会清洗。",
            },
          },
          required: ["keyword"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const raw = String(args.keyword ?? "").trim();
      const keyword = raw.replace(/[《》「」"']/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!keyword) {
        return { error: `无效的搜索关键词: ${args.keyword}` };
      }
      try {
        const list = await biliSearchWithRetry(keyword);
        log.info("biliSearch.done", { keyword, count: list.length });
        return { content: formatBiliCandidates(list, keyword) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("biliSearch.fail", { keyword, error: msg });
        return { error: `B站搜索失败: ${msg}` };
      }
    },
    requiresFollowUp: true,
    timeout: 30000,
    resultMaxLength: 4000,
  };
}

// ====== 工具二：send_bili_card ======

export function createBiliSendTool(): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "send_bili_card",
        description:
          "把选定的B站视频以可点开的B站分享卡发送到指定群。在 search_bili_video 返回候选列表、确定用户要哪条后调用。" +
          "传入目标群号（上下文里 group:xxx 的 xxx）和候选行末尾的 bvid（BV 号）。发送后群里出现B站视频卡片，点开跳B站小程序播放。",
        parameters: {
          type: "object",
          properties: {
            group_id: {
              type: "integer",
              description: "要发送到的群号，从上下文 group:1000000001 这类前缀读取。",
            },
            bvid: {
              type: "string",
              description: "B站视频 BV 号，从 search_bili_video 候选列表每行末尾的 'bvid=BVxxx' 中取。",
            },
          },
          required: ["group_id", "bvid"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const groupId = Number(args.group_id);
      const bvid = String(args.bvid ?? "").trim();
      if (!Number.isFinite(groupId) || groupId <= 0) {
        return { error: `无效的 group_id: ${args.group_id}。应从上下文 group:xxx 读取群号。` };
      }
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
        return {
          error: `无效的 bvid: ${args.bvid}。应从 search_bili_video 候选的 bvid=xxx 读取（形如 BV1GJ411x7h7）。`,
        };
      }
      const meta = candidateCache.get(bvid);
      if (!meta) {
        return {
          error:
            `bvid=${bvid} 不在候选缓存中（进程重启或候选过期）。请先重新调用 search_bili_video 搜索取新候选，再用新 bvid 发送。`,
        };
      }
      try {
        const tsMs = Date.now();
        const jumpUrl = `pages/video/video.html?avid=${meta.aid}`;
        const hexReq = buildBiliReq(meta.title, "", meta.pic, jumpUrl, tsMs);
        const r = await postSnowLuma("/send_packet", {
          cmd: ADAPT_CMD,
          data: hexReq,
          rsp: true,
        });
        if (r.status !== "ok") {
          return { error: `send_packet 失败: ${JSON.stringify(r).slice(0, 300)}` };
        }
        const jsonStr = parseBiliJsonStr(String(r.data ?? ""));
        if (!jsonStr) {
          return { error: "send_packet 响应解析失败（未取到 jsonStr）" };
        }
        const pj = JSON.parse(jsonStr) as Record<string, unknown>;
        const metaData = (pj.metaData ?? pj.meta ?? {}) as Record<string, unknown>;
        const detail1 = (metaData.detail_1 ?? {}) as Record<string, unknown>;
        const sendPayload = {
          app: pj.appName ?? pj.app,
          view: pj.appView ?? pj.view,
          ver: pj.ver,
          desc: String(detail1.desc ?? ""),
          prompt: pj.prompt,
          meta: pj.metaData,
          config: pj.config,
        };
        const msg = [
          {
            type: "json",
            data: { data: JSON.stringify(sendPayload) },
          },
        ];
        const r2 = await postSnowLuma("/send_group_msg", {
          group_id: groupId,
          message: msg,
        });
        if (r2.status === "ok") {
          const mid = (r2.data as { message_id?: number } | undefined)?.message_id ?? "?";
          log.info("biliSend.done", { group_id: groupId, bvid, message_id: mid });
          return {
            content:
              `B站视频卡片已发送到群 ${groupId}（${meta.title}，bvid=${bvid}）。` +
              `若用户对版本不满意，可再 search_bili_video 换关键词重试。`,
          };
        }
        const errMsg = JSON.stringify(r2).slice(0, 300);
        log.warn("biliSend.fail", { group_id: groupId, bvid, error: errMsg });
        return { error: `发送失败: ${errMsg}` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("biliSend.error", { group_id: groupId, bvid, error: msg });
        return { error: `发送失败: ${msg}` };
      }
    },
    requiresFollowUp: true,
    timeout: 30000,
    resultMaxLength: 2000,
  };
}
