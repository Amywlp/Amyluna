/**
 * get_time 工具 — 返回服务器时间。
 * 从 v1 tools/builtin/get-time.ts 迁移。
 */

import type { ToolMeta } from "../types";

export const getTimeTool: ToolMeta = {
  definition: {
    type: "function",
    function: {
      name: "get_time",
      description: "Return the current server date and time in ISO 8601 format.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "Optional IANA timezone (e.g. 'Asia/Shanghai'). Defaults to UTC.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args) => {
    const tz = typeof args.timezone === "string" ? args.timezone.trim() : "";

    try {
      const now = new Date();
      const iso = tz
        ? now.toLocaleString("sv-SE", { timeZone: tz }) + "Z"
        : now.toISOString();

      return {
        content: JSON.stringify({
          datetime: iso,
          timezone: tz || "UTC",
          unix_ms: now.getTime(),
        }),
      };
    } catch {
      return { error: `Invalid or unsupported timezone: "${tz}"` };
    }
  },
  requiresFollowUp: true,
  timeout: 5000,
  resultMaxLength: 300,
};
