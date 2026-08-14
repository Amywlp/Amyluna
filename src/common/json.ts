/**
 * 安全 JSON 解析。
 * 迁移自 v1 utils/json.ts。
 */

export function safeJsonParse<T = unknown>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonParseOrNull<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
