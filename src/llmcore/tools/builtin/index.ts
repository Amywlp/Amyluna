/**
 * 非静默工具注册入口（仅注册 P3 内部执行的工具）。
 * 静默工具（get_meme, update_affinity 等）不在此注册，由 P2 处理。
 * 从 v1 tools/builtin/index.ts 迁移，仅保留非静默工具。
 */

import { ToolRegistry } from "../registry";
import { webSearchTool } from "./web-search";
import { getTimeTool } from "./get-time";
import { createTempMuteTool } from "./temp-mute";
import { createContextReviewTool } from "./context-review";
import type { IpcClient } from "../../../common/ipc/client";
import type { MessageRepository } from "../../../common/db/message-repository";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

export function registerBuiltinTools(
  registry: ToolRegistry,
  p1Client: IpcClient,
  repo: MessageRepository,
): void {
  log.info("register.start");
  registry.register(webSearchTool);
  registry.register(getTimeTool);
  registry.register(createTempMuteTool(p1Client));
  registry.register(createContextReviewTool(repo));
  log.info("register.done", { count: registry.getToolDefinitions().length });
}
