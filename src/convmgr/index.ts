/**
 * P2 — Conversation Manager 入口 (:3102)
 *
 * 启动顺序:
 *   加载 config → 连接 DB → 初始化 repos → 初始化 AffinityCache
 *   → 创建 IPC Clients (→P1, →P3) → 启动 IPC Server → 启动 Watchdog
 *
 * 职责:
 *   - 接收 P1 trigger → 冷却判断 → 上下文构建 → 发给 P3
 *   - 接收 P3 chat_response → 静默工具执行 → 后处理 → 发给 P1
 *   - 接收 P3 intermediate_reply → 后处理 → 发给 P1
 *   - 好感度管理 (AffinityCache)
 */
import { loadConfig } from "../common/config";
import { createLogger } from "../common/logger";
import { createPool, ensureTables } from "../common/db/pool";
import { MessageRepository } from "../common/db/message-repository";
import { Watchdog } from "../common/watchdog";
import { AffinityCache } from "./affinity/cache";
import { AffinityInjector } from "./affinity/injector";
import { CooldownManager } from "./cooldown";
import { ContextBuilder } from "./context-builder";
import { createDecomposePostProcessor } from "./post-process";
import { SilentToolExecutor } from "./silent-tools";
import type { SilentToolExecutorOptions } from "./silent-tools";
import { MuriAgentExecutor } from "./muri-agent/executor";
import { TimerManager } from "./timer-manager";
import { TaskQueueManager } from "./task-queue-manager";
import type { ToolDefinition } from "./task-queue-types";
import { VoiceRegistry } from "./tts/voices";
import { SoVitsClient } from "./tts/so-vits-client";
import { TtsExecutor } from "./tts/executor";
import { Text2ImageExecutor } from "./text2image/executor";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcClient } from "../common/ipc/client";
import { createP2IpcServer } from "./ipc-server";
import type { P2IpcServerDeps } from "./ipc-server";

const log = createLogger("P2");

// ─── 后台连接 ──────────────────────────────────────────

/** 启动持久连接（后台无限重连，永不阻塞，不因对端未就绪而退出） */
function connectPeers(p1Client: IpcClient, p3Client: IpcClient): void {
  p1Client.connectPersistent("P1");
  p3Client.connectPersistent("P3");
}

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("startup", { port: config.p2Port });

  // 1. 连接 DB + 建表
  const pool = createPool(config.db);
  await ensureTables(pool);
  const repo = new MessageRepository(pool);
  log.info("db ready");

  // 2. 初始化好感度缓存
  const affinityCache = new AffinityCache(pool);
  await affinityCache.init();
  log.info("affinity ready");

  // 3. 创建注入器列表
  const affinityInjector = new AffinityInjector(affinityCache);
  const injectors = [affinityInjector];

  // 4. 后处理器
  const postProcessor = createDecomposePostProcessor();

  // 5. 创建 IPC Clients（TimerManager 依赖 p1Client 发送提醒消息）
  const p1Client = new IpcClient(config.p1Port, "P2→P1");
  const p3Client = new IpcClient(config.p3Port, "P2→P3");

  // 6. 定时器管理器（到期时通过 P1 发送提醒）
  const timerManager = new TimerManager(async (userId, groupId, eventText) => {
    const atMention = `[CQ:at,qq=${userId}]`;
    const message = `${atMention} 时间到啦！"${eventText}"`;
    log.info("timer.sendReminder", { userId, groupId, eventText });
    try {
      await p1Client.request("send_message", {
        group_id: groupId,
        message,
      }, 10000);
    } catch (err) {
      log.error("timer.sendReminder.fail", { userId, groupId, error: String(err) });
    }
  });

  // 7. 任务队列管理器（用于需要生命周期管理的静默工具）
  const queuedTools = config.silentTool.queuedTools;
  const serialTools = config.taskQueue.serialTools;
  const taskQueue = queuedTools.size > 0 ? new TaskQueueManager() : null;

  if (taskQueue) {
    // 注册所有已知静默工具到队列管理器（确定并行/串行属性）
    const allSilentTools: ToolDefinition[] = [
      { type: "timer",       parallel: !serialTools.has("timer"),       description: "定时提醒" },
      { type: "affinity",    parallel: !serialTools.has("affinity"),    description: "好感度变更" },
      { type: "tts",         parallel: !serialTools.has("tts"),         description: "语音合成（串行）" },
      { type: "muri_agent",  parallel: !serialTools.has("muri_agent"),  description: "子代理（占位）" },
      { type: "text2image",  parallel: !serialTools.has("text2image"),  description: "文生图（串行）" },
    ];
    for (const def of allSilentTools) {
      if (queuedTools.has(def.type)) {
        taskQueue.registerTool(def);
      }
    }
    log.info("taskQueue.enabled", {
      queuedTools: [...queuedTools],
      serialTools: [...serialTools],
    });
  }

  // 8. Muri Agent 执行器
  const muriAgentExecutor = new MuriAgentExecutor(p3Client, p1Client, repo, taskQueue);

  // 8.5. TTS 语音合成栈（VoiceRegistry → SoVitsClient → TtsExecutor）
  const ttsConfig = config.tts;
  const voiceRegistry = new VoiceRegistry(ttsConfig.voiceConfigDir, ttsConfig.voice);
  const ttsEnabled = voiceRegistry.load();

  let ttsExecutor: TtsExecutor | undefined;
  if (ttsEnabled) {
    const soVitsClient = new SoVitsClient(ttsConfig.baseUrl, ttsConfig.apiTimeoutMs, ttsConfig.maxRetries);
    ttsExecutor = new TtsExecutor({
      p1Client,
      taskQueue,
      botId: config.chat.botId,
      registry: voiceRegistry,
      client: soVitsClient,
      outputDir: ttsConfig.outputDir,
      defaultLang: ttsConfig.defaultLang,
      maxTextLen: ttsConfig.maxTextLen,
      fileTtlMs: ttsConfig.fileTtlMs,
      sendMode: ttsConfig.sendMode,
    });
    log.info("tts.stackReady", { voice: ttsConfig.voice, sendMode: ttsConfig.sendMode, baseUrl: ttsConfig.baseUrl });
  } else {
    log.warn("tts.disabled", { configDir: ttsConfig.voiceConfigDir, voice: ttsConfig.voice });
  }

  // 8.6. Text2Image 文生图栈
  const t2iConfig = config.text2image;
  let text2imageExecutor: Text2ImageExecutor | undefined;

  if (t2iConfig.apiKey) {
    // 加载文生图系统预设
    let systemPrompt = "";
    try {
      const presetPath = path.resolve(t2iConfig.presetPath);
      systemPrompt = fs.readFileSync(presetPath, "utf-8").trim();
      if (!systemPrompt) {
        log.warn("text2image.emptyPreset", { path: presetPath });
      }
    } catch (err) {
      log.warn("text2image.presetLoadFail", { path: t2iConfig.presetPath, error: String(err) });
    }

    if (systemPrompt) {
      text2imageExecutor = new Text2ImageExecutor({
        p1Client,
        taskQueue,
        botId: config.chat.botId,
        config: t2iConfig,
        systemPrompt,
      });
      log.info("text2image.stackReady", {
        baseUrl: t2iConfig.baseUrl,
        promptModel: t2iConfig.promptModel,
        imageModel: t2iConfig.imageModel,
        imageSize: t2iConfig.imageSize,
        outputDir: t2iConfig.outputDir,
      });
    } else {
      log.warn("text2image.disabled", { reason: "preset is empty or failed to load" });
    }
  } else {
    log.warn("text2image.disabled", { reason: "no API key" });
  }

  // 9. 静默工具执行器（集成任务队列 + muri_agent + tts）
  const silentToolOptions: SilentToolExecutorOptions = {
    taskQueue: taskQueue ?? undefined,
    queuedTools,
    muriAgentExecutor,
    ttsExecutor,
    text2imageExecutor,
  };
  const silentTools = new SilentToolExecutor(affinityCache, timerManager, silentToolOptions);

  // 10. 冷却管理器
  const cooldown = new CooldownManager(config.chat.cooldownMs);

  // 11. 启动 IPC Server（先监听，让 P1/P3 可以连接）
  const deps: P2IpcServerDeps = {
    cooldown,
    createContextBuilder: (groupId: number) =>
      new ContextBuilder({
        repo,
        groupId,
        botId: config.chat.botId,
        contextLimit: config.chat.contextLimit,
        injectors,
      }),
    postProcessor,
    silentTools,
    repo,
    p3Client,
    p1Client,
    botId: config.chat.botId,
    preset: config.chat.presetName,
    replyMaxLength: config.chat.replyMaxLength,
    replyTimeoutMs: config.chat.replyTimeoutMs,
    taskQueue: taskQueue ?? undefined,
    errorAlertGroupId: config.chat.errorAlertGroupId,
    affinityCache,
  };

  const ipcServer = createP2IpcServer(config.p2Port, deps);
  await ipcServer.start();
  log.info("ipc server ready");

  // 12. 持久连接 P1 和 P3（后台无限重连，不阻塞）
  connectPeers(p1Client, p3Client);

  // 13. 启动 Watchdog（监控 P1 和 P3）
  const watchdog = new Watchdog("P2", {
    pingTargets: [
      { label: "P1", port: config.p1Port },
      { label: "P3", port: config.p3Port },
    ],
    intervalMs: config.watchdog.intervalMs,
    maxFailures: config.watchdog.maxFailures,
  });
  await watchdog.start();

  // 13. 优雅关闭（SIGINT/SIGTERM）
  const shutdown = (signal: string) => {
    log.info("shutdown.signal", { signal });
    if (taskQueue) {
      taskQueue.destroy();
    }
    timerManager.destroy();
    cooldown.destroy();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("ready", { port: config.p2Port });

  console.log(`[P2] Conversation Manager ready on :${config.p2Port}`);
  console.log(`[P2] Cooldown: ${config.chat.cooldownMs}ms, Context: ${config.chat.contextLimit} messages`);
}

// 仅在直接运行时启动
const isMain = process.argv[1]?.includes("convmgr/index");
if (isMain) {
  main().catch((error) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("startup.fail", { error: errMsg });
    console.error("[P2] startup failed:", errMsg);
    process.exit(1);
  });
}
