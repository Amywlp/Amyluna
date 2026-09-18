/**
 * search_song / send_song_card 工具 — QQ 群点歌（网易云 → QQ 音乐卡片）。
 *
 * 多轮交互设计（仿 koishi music-voice 的人工选歌，交由 LLM 判断）：
 *   第一轮 search_song(关键词) → 返回候选列表（≤8 条，含序号）
 *   第二轮 send_song_card(群号, 序号) → 发 music type=163 卡片到群
 *
 * 为何不用静默工具：选歌需要判断（网易云排序把翻唱顶前面），由 LLM 看完
 * 候选后自行决定发哪首 / 是否反问用户；标准工具两轮 function calling 正好承接。
 *
 * 网易云接口经验（2026-09-03 实测）：
 *   - 匿名 /api/search/get/web 连续请求会被风控 → 无缓存时 5s 退避重试
 *   - 排序对宽泛歌名不保证原唱在前 → 候选展示 + LLM 判断
 */

import type { ToolMeta } from "../types";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

const NCM_SEARCH_URL = "https://music.163.com/api/search/get/web";
const SEARCH_TIMEOUT_MS = 15000;
const MAX_RETRY = 2;
const RETRY_DELAY_MS = 5000;
const CANDIDATE_LIMIT = 8;

/** 候选歌曲结构 */
export interface SongCandidate {
  seq: number;
  id: number;
  name: string;
  artists: string;
  album: string;
  duration: number;
}

/** 网易云匿名搜索一次 */
async function httpSearch(keyword: string): Promise<SongCandidate[]> {
  const url = new URL(NCM_SEARCH_URL);
  url.searchParams.set("s", keyword);
  url.searchParams.set("type", "1");
  url.searchParams.set("offset", "0");
  url.searchParams.set("total", "true");
  url.searchParams.set("limit", String(CANDIDATE_LIMIT));

  const resp = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
      "Referer": "https://music.163.com/",
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`网易云搜索 HTTP ${resp.status}`);
  const data = (await resp.json()) as { result?: { songs?: Array<Record<string, unknown>> } };
  const songs = data.result?.songs ?? [];
  return songs.map((s, i) => ({
    seq: i + 1,
    id: Number(s.id),
    name: String(s.name ?? ""),
    artists: ((s.artists as Array<{ name?: string }> | undefined) ?? [])
      .map((a) => a.name ?? "")
      .join("/"),
    album: String((s.album as { name?: string } | undefined)?.name ?? ""),
    duration: Math.floor((Number(s.duration) || 0) / 1000),
  }));
}

/** 搜索带退避重试（风控规避） */
async function searchWithRetry(keyword: string): Promise<SongCandidate[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    try {
      const songs = await httpSearch(keyword);
      if (songs.length > 0) return songs;
      lastErr = new Error("搜索结果为空（可能被风控或关键词无结果）");
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      log.warn("songSearch.retry", { attempt: attempt + 1, error: lastErr.message });
    }
    if (attempt < MAX_RETRY) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error("网易云搜索失败");
}

/** 格式化候选列表为 LLM 可读文本 */
function formatCandidates(songs: SongCandidate[], keyword: string): string {
  const lines = songs.map(
    (s) =>
      `${s.seq}. ${s.name} — ${s.artists}（专辑:${s.album}｜${s.duration}s｜id=${s.id}）`,
  );
  return [
    `【网易云搜索】关键词「${keyword}」共 ${songs.length} 条候选：`,
    ...lines,
    "",
    "请根据用户的点歌意图（歌名、歌手、原唱/翻唱、版本）判断选哪首：",
    "能明确确定 → 调用 send_song_card(群号, 序号) 直接发送；",
    "拿不准（如全是翻唱、用户要原唱但列表没有）→ 可向用户说明并询问更具体信息，不要乱选。",
  ].join("\n");
}

export function createSongSearchTool(): ToolMeta {
  return {
    definition: {
      type: "function",
      function: {
        name: "search_song",
        description:
          "搜索网易云歌曲，返回候选列表（含序号/歌名/歌手/专辑/时长）。" +
          "当用户点歌/要你放某首歌/询问某首歌时，调用本工具传入用户说的歌名或'歌名 歌手'，即可获得候选。返回后你会看到列表，" +
          "请在下一轮结合用户意图判断：确定选哪首就调用 send_song_card(群号, 序号) 发到群里；" +
          "拿不准（列表全是翻唱/找不到原唱等）可询问用户更具体的信息。",
        parameters: {
          type: "object",
          properties: {
            keyword: {
              type: "string",
              description:
                "搜索关键词：用户说的歌名，尽量带上歌手名（如 '晴天 周杰伦'、'成为魔法少女吧'）。可含书名号、空格，系统会清洗。",
            },
          },
          required: ["keyword"],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const raw = String(args.keyword ?? "").trim();
      // 清洗：去书名号/引号、压缩空白
      const keyword = raw.replace(/[《》「」"']/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!keyword) {
        return { error: `无效的搜索关键词: ${args.keyword}` };
      }

      try {
        const songs = await searchWithRetry(keyword);
        log.info("songSearch.done", { keyword, count: songs.length });
        return { content: formatCandidates(songs, keyword) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn("songSearch.fail", { keyword, error: msg });
        return { error: `网易云搜索失败: ${msg}` };
      }
    },
    requiresFollowUp: true,
    timeout: SEARCH_TIMEOUT_MS + (MAX_RETRY * RETRY_DELAY_MS) + 3000,
    resultMaxLength: 4000,
  };
}
