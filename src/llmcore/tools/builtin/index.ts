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
import { createResolveMediaTool } from "./resolve-media";
import { createSongSearchTool } from "./song-search";
import { createSongSendTool } from "./song-send";
import { createBiliSearchTool, createBiliSendTool } from "./bili-video";
import type { IpcClient } from "../../../common/ipc/client";
import type { MessageRepository } from "../../../common/db/message-repository";
import type { FileRepository } from "../../../common/db/file-repository";
import type { LLMRelay } from "../../llm/relay";
import type { VisionConfig } from "../../vision";
import { createLogger } from "../../../common/logger";

const log = createLogger("P3.tools");

export interface BuiltinToolDeps {
  p1Client: IpcClient;
  repo: MessageRepository;
  fileRepo: FileRepository;
  relay: LLMRelay;
  visionConfig: VisionConfig;
}

export function registerBuiltinTools(registry: ToolRegistry, deps: BuiltinToolDeps): void {
  log.info("register.start");
  registry.register(webSearchTool);
  registry.register(getTimeTool);
  registry.register(createTempMuteTool(deps.p1Client));
  registry.register(createContextReviewTool(deps.repo));
  registry.register(createResolveMediaTool(deps));
  registry.register(createSongSearchTool());
  registry.register(createSongSendTool({ p1Client: deps.p1Client }));
  registry.register(createBiliSearchTool());
  registry.register(createBiliSendTool());
  log.info("register.done", { count: registry.getToolDefinitions().length });
}
