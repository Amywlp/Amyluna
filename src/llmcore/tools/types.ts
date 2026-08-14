/**
 * Tool 系统类型定义。
 * 从 v1 tools/types.ts 迁移。
 */

import type { ToolDefinition } from "../llm/types";

export interface ToolMeta {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  requiresFollowUp: boolean;
  /** block: P3 视为静默工具，不执行 */
  block?: boolean;
  timeout?: number;
  resultMaxLength?: number;
}

export interface ToolResult {
  content?: string;
  error?: string;
}
