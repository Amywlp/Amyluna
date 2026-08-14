/**
 * TtsExecutor — TTS 语音合成执行器。
 *
 * 执行流程:
 *   1. enabled / text 校验
 *   2. taskQueue.waitForRunning() → 等待串行槽位
 *   3. VoiceRegistry.resolve(lang) → 语音配置
 *   4. SoVitsClient.synthesize() → WAV Buffer
 *   5. 保存到 outputDir
 *   6. 根据 sendMode 分发发送策略:
 *      - sequential:    三条独立消息顺序发送（默认 ✅）
 *      - forward-audio: 合并转发卡片（保留 ⚠️，QQ bug）
 *      - forward-video: WAV→MP4→合并转发（占位 🔧）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../common/logger";
import type { TtsCall } from "../silent-text-extractor";
import type {
  TtsExecutorOptions,
  TtsResult,
} from "./types";
import { VALID_TTS_LANGS } from "./types";

const log = createLogger("P2.tts.executor");

/** 文件名序号计数器 */
let fileSeq = 0;

export class TtsExecutor {
  private readonly p1Client: TtsExecutorOptions["p1Client"];
  private readonly taskQueue: TtsExecutorOptions["taskQueue"];
  private readonly botId: number;
  private readonly registry: TtsExecutorOptions["registry"];
  private readonly client: TtsExecutorOptions["client"];
  private readonly outputDir: string;
  private readonly defaultLang: string;
  private readonly maxTextLen: number;
  private readonly fileTtlMs: number;
  private readonly sendMode: TtsExecutorOptions["sendMode"];

  constructor(options: TtsExecutorOptions) {
    this.p1Client = options.p1Client;
    this.taskQueue = options.taskQueue;
    this.botId = options.botId;
    this.registry = options.registry;
    this.client = options.client;
    this.outputDir = options.outputDir;
    this.defaultLang = options.defaultLang;
    this.maxTextLen = options.maxTextLen;
    this.fileTtlMs = options.fileTtlMs;
    this.sendMode = options.sendMode;

    // 确保输出目录存在
    fs.mkdirSync(this.outputDir, { recursive: true });

    // 启动时清理过期文件
    this.purgeOldFiles();

    log.info("tts.executorReady", {
      sendMode: this.sendMode,
      outputDir: this.outputDir,
      maxTextLen: this.maxTextLen,
      defaultLang: this.defaultLang,
      enabled: this.registry.enabled,
    });
  }

  /**
   * 执行 TTS 合成。
   *
   * @param call 提取到的 TTS 调用
   * @param groupId 群 ID
   * @param taskId 任务队列 ID（用于 waitForRunning + transition）
   */
  async execute(call: TtsCall, groupId: number, taskId?: string): Promise<TtsResult> {
    const startTime = Date.now();

    // 1. enabled 检查
    if (!this.registry.enabled) {
      const result: TtsResult = { success: false, error: "TTS disabled: no voice configs loaded", durationMs: 0 };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    // 2. text 非空校验
    if (!call.text || call.text.trim().length === 0) {
      log.warn("tts.emptyText", { groupId, taskId });
      const result: TtsResult = { success: false, error: "tts.emptyText", durationMs: 0 };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    const text = call.text.trim().slice(0, this.maxTextLen);

    // 3. lang 校验 + 回退
    let lang = (call.lang ?? this.defaultLang).toLowerCase();
    if (!VALID_TTS_LANGS.has(lang)) {
      log.warn("tts.invalidLang", { lang, fallback: this.defaultLang });
      lang = this.defaultLang;
    }
    // "auto" 回退到默认语言
    if (lang === "auto") {
      lang = this.defaultLang;
    }

    // 4. 解析语音配置
    const voiceConfig = this.registry.resolve(lang);
    if (!voiceConfig) {
      const result: TtsResult = {
        success: false,
        error: `No voice config for lang="${lang}"`,
        durationMs: Date.now() - startTime,
      };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    // 5. 等待串行槽位（如果注册了任务队列）
    if (taskId && this.taskQueue) {
      const gotSlot = await this.taskQueue.waitForRunning(taskId, 120000);
      if (!gotSlot) {
        const result: TtsResult = {
          success: false,
          error: "tts.waitForRunning.timeoutOrCancelled",
          durationMs: Date.now() - startTime,
        };
        if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
        return result;
      }
    }

    // 6. 调用 SoVITS 合成
    let audioBuffer: Buffer;
    try {
      audioBuffer = await this.client.synthesize({
        text,
        textLang: lang,
        refAudioPath: voiceConfig.refAudioPath,
        promptLang: voiceConfig.promptLang,
        promptText: voiceConfig.promptText,
        auxRefAudioPaths: voiceConfig.auxRefAudioPaths,
        inference: voiceConfig.inference,
        gptModelPath: voiceConfig.gptModelPath,
        sovitsModelPath: voiceConfig.sovitsModelPath,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("tts.synthesizeFail", { groupId, taskId, error: errMsg });
      const result: TtsResult = {
        success: false,
        error: `tts.synthesizeFail: ${errMsg}`,
        durationMs: Date.now() - startTime,
      };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    // 7. 保存音频文件
    const seq = ++fileSeq;
    const audioFileName = `tts-${Date.now()}-${seq}.wav`;
    const audioPath = path.join(this.outputDir, audioFileName);

    try {
      fs.writeFileSync(audioPath, audioBuffer);
      log.info("tts.saved", { path: audioPath, sizeBytes: audioBuffer.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("tts.saveFail", { path: audioPath, error: errMsg });
      const result: TtsResult = {
        success: false,
        error: `tts.saveFail: ${errMsg}`,
        durationMs: Date.now() - startTime,
        audioBuffer,
      };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    // 8. 发送结果
    try {
      await this.sendResult(audioPath, { text, lang, translation: call.translation }, groupId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("tts.sendFail", { groupId, taskId, error: errMsg });
      const result: TtsResult = {
        success: true, // 音频已合成，只是发送失败
        audioPath,
        audioBuffer,
        error: `sendFail: ${errMsg}`,
        durationMs: Date.now() - startTime,
      };
      if (taskId && this.taskQueue) this.taskQueue.transition(taskId, "failed", result.error);
      return result;
    }

    // 9. 标记任务完成
    if (taskId && this.taskQueue) {
      this.taskQueue.transition(taskId, "completed");
    }

    const result: TtsResult = {
      success: true,
      audioPath,
      audioBuffer,
      durationMs: Date.now() - startTime,
    };
    log.info("tts.done", { groupId, taskId, textLen: text.length, lang, durationMs: result.durationMs });
    return result;
  }

  // ─── 发送策略 ──────────────────────────────────────────

  /** 根据 sendMode 分发发送 */
  private async sendResult(audioPath: string, call: { text: string; lang: string; translation?: string }, groupId: number): Promise<void> {
    switch (this.sendMode) {
      case "sequential":
        return this.sendSequential(audioPath, call, groupId);
      case "forward-audio":
        return this.sendForwardAudio(audioPath, call, groupId);
      case "forward-video":
        return this.sendForwardVideo(audioPath, call, groupId);
    }
  }

  /**
   * sequential 模式（默认 ✅）：
   * 1. 音频 → 独立 record 消息
   * 2. 原文 + 译文合并 → 独立文本消息（非中文时含翻译）
   */
  private async sendSequential(
    audioPath: string,
    call: { text: string; lang: string; translation?: string },
    groupId: number,
  ): Promise<void> {
    // 1. 发送音频 record 消息
    log.info("tts.sequential.audio", { groupId, audioPath });
    await this.p1Client.request("send_message", {
      group_id: groupId,
      message: "",
      method: "normal",
      tts_audio: audioPath,
    }, 15000);

    // 短暂间隔，确保消息顺序
    await sleep(300);

    // 2. 原文 + 译文合并发送
    let textMsg = `「${call.text}」`;
    if (call.lang !== "zh" && call.translation) {
      textMsg += `\n（中文翻译：${call.translation}）`;
    }
    log.info("tts.sequential.text", { groupId, len: textMsg.length });
    await this.p1Client.request("send_message", {
      group_id: groupId,
      message: textMsg,
      method: "normal",
    }, 10000);
  }

  /**
   * forward-audio 模式（保留 ⚠️）：
   * 音频 + 文字放入合并转发卡片。
   * 已知问题：QQ 端合并转发中 record 段无法播放。
   */
  private async sendForwardAudio(
    audioPath: string,
    call: { text: string; lang: string; translation?: string },
    groupId: number,
  ): Promise<void> {
    const nodes: Array<Record<string, unknown>> = [];

    // 节点1: 音频 record
    nodes.push({
      uin: this.botId,
      name: "赫萝",
      message: [{ type: "record", data: { file: `file://${audioPath}` } }],
    });

    // 节点2: 原文 + 译文合并
    let textContent = `「${call.text}」`;
    if (call.lang !== "zh" && call.translation) {
      textContent += `\n（中文翻译：${call.translation}）`;
    }
    nodes.push({
      uin: this.botId,
      name: "赫萝",
      content: textContent,
    });

    log.info("tts.forwardAudio", { groupId, nodeCount: nodes.length });
    await this.p1Client.request("send_message", {
      group_id: groupId,
      message: "",
      method: "forward",
      forward_nodes: nodes,
    }, 20000);
  }

  /**
   * forward-video 模式（占位 🔧）：
   * WAV→MP4 转换后放入合并转发卡片。
   * wavToVideo() 当前抛出 "not implemented"。
   */
  private async sendForwardVideo(
    audioPath: string,
    call: { text: string; lang: string; translation?: string },
    groupId: number,
  ): Promise<void> {
    let mp4Path: string;
    try {
      mp4Path = await wavToVideo(audioPath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("tts.wavToVideo.notImplemented", { audioPath, error: errMsg });
      // 占位期间回退到 sequential
      log.info("tts.forwardVideo.fallbackToSequential", { groupId });
      return this.sendSequential(audioPath, call, groupId);
    }

    const nodes: Array<Record<string, unknown>> = [];

    // 节点1: 视频
    nodes.push({
      uin: this.botId,
      name: "赫萝",
      message: [{ type: "video", data: { file: `file://${mp4Path}` } }],
    });

    // 节点2: 原文 + 译文合并
    let textContent = `「${call.text}」`;
    if (call.lang !== "zh" && call.translation) {
      textContent += `\n（中文翻译：${call.translation}）`;
    }
    nodes.push({
      uin: this.botId,
      name: "赫萝",
      content: textContent,
    });

    log.info("tts.forwardVideo", { groupId, nodeCount: nodes.length, mp4Path });
    await this.p1Client.request("send_message", {
      group_id: groupId,
      message: "",
      method: "forward",
      forward_nodes: nodes,
    }, 20000);
  }

  // ─── 辅助 ──────────────────────────────────────────────

  /** 启动时清理超过 fileTtlMs 的旧音频文件 */
  private purgeOldFiles(): void {
    try {
      const now = Date.now();
      const cutoff = now - this.fileTtlMs;
      const entries = fs.readdirSync(this.outputDir, { withFileTypes: true });
      let purged = 0;

      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith("tts-") || !entry.name.endsWith(".wav")) continue;

        const fullPath = path.join(this.outputDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
            purged++;
          }
        } catch (err) {
          log.warn("tts.purge.skip", { file: entry.name, error: String(err) });
        }
      }

      if (purged > 0) {
        log.info("tts.purge", { purged, remaining: entries.length - purged });
      }
    } catch (err) {
      // 目录不存在等场景静默忽略
      log.debug("tts.purge.dirError", { error: String(err) });
    }
  }
}

/**
 * WAV → MP4 转换占位函数。
 *
 * TODO: 使用 ffmpeg 将 WAV + 静态封面图合成为 MP4:
 *   ffmpeg -loop 1 -i cover.png -i audio.wav -c:v libx264 -tune stillimage \
 *     -c:a aac -b:a 192k -pix_fmt yuv420p -shortest output.mp4
 *
 * @throws Error "wavToVideo not implemented"
 */
export async function wavToVideo(_wavPath: string): Promise<string> {
  throw new Error("wavToVideo not implemented");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
