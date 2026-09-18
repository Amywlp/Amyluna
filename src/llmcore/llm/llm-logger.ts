/**
 * LLM 响应专用日志：将每次 API 调用的完整响应写入 logs/llm-YYYY-MM-DD.log。
 * 从 v1 llm/response-logger.ts 迁移。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { LLMResponse } from "./types";

function resolveLogDir(): string {
  return path.resolve(process.cwd(), "logs");
}

function getLogPath(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(resolveLogDir(), `llm-${y}-${m}-${d}.log`);
}

function writeLine(data: Record<string, unknown>): void {
  const line = JSON.stringify(data);
  const logPath = getLogPath();
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
  } catch {
    console.error(`[llm-logger] failed to write: ${line.slice(0, 200)}`);
  }
}

export function logLLMResponse(
  response: LLMResponse,
  context: { turn: number; msgCount: number },
): void {
  writeLine({
    ts: new Date().toISOString(),
    module: "P3.llm",
    turn: context.turn,
    provider: response.provider ?? "unknown",
    model: response.model ?? "unknown",
    msgCount: context.msgCount,
    finishReason: response.finishReason,
    content: response.content,
    reasoningContent: response.reasoningContent ?? null,
    toolCalls: response.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
    usage: response.usage,
  });
}
