/**
 * web_search 工具 — Tavily 搜索 API。
 * 从 v1 tools/builtin/web-search.ts 迁移。
 */

import type { ToolMeta } from "../types";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? ""; // 从环境变量读取，勿硬编码

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  query: string;
  answer?: string;
  results: TavilyResult[];
  response_time: number;
}

async function searchTavily(query: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return `[web_search] HTTP ${res.status}`;
    }

    const data = (await res.json()) as TavilyResponse;
    const parts: string[] = [];

    if (data.answer) {
      parts.push(data.answer);
    }

    for (const r of data.results ?? []) {
      const line = `[${r.title}](${r.url}): ${r.content}`;
      parts.push(line);
    }

    return parts.join("\n\n") || `[web_search] No results found for "${query}"`;
  } catch (e) {
    clearTimeout(timer);
    return `[web_search] Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const webSearchTool: ToolMeta = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Use when the user asks about real-time events, news, or facts you are not certain about.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query" } },
        required: ["query"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "search query is empty" };
    log.info("webSearch.start", { queryLen: query.length });
    const result = await searchTavily(query);
    log.info("webSearch.done", { resultLen: result.length });
    return { content: result };
  },
  requiresFollowUp: true,
  timeout: 25000,
  resultMaxLength: 3000,
};
