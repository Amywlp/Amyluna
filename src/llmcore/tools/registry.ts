/**
 * Tool 注册表：注册/查找/执行工具。
 * P3 仅注册非静默工具。不在 registry 中的 tool_call 视为静默工具，由 P2 执行。
 * 从 v1 tools/registry.ts 迁移。
 */

import type { ToolMeta, ToolResult } from "./types";
import type { ToolDefinition } from "../llm/types";
import { createLogger } from "../../common/logger";

const log = createLogger("P3.tools");

export class ToolRegistry {
  private tools = new Map<string, ToolMeta>();

  register(meta: ToolMeta): void {
    const name = meta.definition.function.name;
    if (this.tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.tools.set(name, meta);
    log.info("register", { tool: name, requiresFollowUp: meta.requiresFollowUp });
  }

  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  findByName(name: string): ToolMeta | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const meta = this.tools.get(name);
    if (!meta) {
      return { error: `Tool not found: ${name}` };
    }
    const timeoutMs = meta.timeout ?? 30000;
    try {
      const startTime = Date.now();
      log.info("execute.start", { tool: name });
      const result = await Promise.race([
        meta.execute(args),
        new Promise<ToolResult>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Tool "${name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      const elapsed = Date.now() - startTime;
      if (meta.resultMaxLength && result.content && result.content.length > meta.resultMaxLength) {
        result.content = result.content.slice(0, meta.resultMaxLength) + "... (truncated)";
      }
      log.info("execute.done", {
        tool: name,
        elapsedMs: elapsed,
        hasContent: !!result.content,
        hasError: !!result.error,
      });
      return result;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error("execute.timeout", { tool: name, error: errMsg });
      return { error: errMsg };
    }
  }
}
