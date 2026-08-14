/**
 * 结构化 JSON 日志，支持进程标签和按日写入。
 *
 * 用法:
 *   import { createLogger } from "../common/logger";
 *   const log = createLogger("P1");
 *   log.info("startup.done", { port: 3101 });
 */

import * as fs from "node:fs";
import * as path from "node:path";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface Logger {
  debug: (event: string, data?: Record<string, unknown>) => void;
  info: (event: string, data?: Record<string, unknown>) => void;
  warn: (event: string, data?: Record<string, unknown>) => void;
  error: (event: string, data?: Record<string, unknown>) => void;
}

function resolveLogDir(): string {
  return path.resolve(process.cwd(), "logs");
}

function getLogPath(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(resolveLogDir(), `${y}-${m}-${d}.log`);
}

function writeLine(level: LogLevel, module: string, event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    module,
    event,
    ...(data && Object.keys(data).length > 0 ? data : {}),
  });

  const logPath = getLogPath();
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
  } catch {
    console.error(`[logger] failed to write: ${line.slice(0, 200)}`);
  }
}

export function createLogger(module: string): Logger {
  return {
    debug: (event, data) => writeLine("DEBUG", module, event, data),
    info: (event, data) => writeLine("INFO", module, event, data),
    warn: (event, data) => writeLine("WARN", module, event, data),
    error: (event, data) => writeLine("ERROR", module, event, data),
  };
}
