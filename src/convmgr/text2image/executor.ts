/**
 * Text2ImageExecutor — 文生图静默工具执行器。
 *
 * 工作流程：
 *   1. 等待串行槽位（若走任务队列）
 *   2. 调用 LLM API 将用户主题展开为结构化图片提示词
 *   3. 调用图片生成 API 生成图片
 *   4. 下载图片到本地暂存目录
 *   5. 通过 P1 发送图片到 QQ 群
 *   6. 发送元数据文本（主题、尺寸、token 消耗、耗时）
 *
 * 错误处理：
 *   - 任务队列模式：transition(taskId, "failed", error) 并发送错误消息到触发群
 *   - 直接模式：发送错误消息到触发群
 *
 * HTTP 重试策略（与 SoVitsClient / LLMClient 保持一致）：
 *   - 4xx → 不重试，立即失败
 *   - 5xx / 网络错误 → 重试（最多 maxRetries 次，指数退避）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../common/logger";
import type { Text2ImageCall } from "../silent-text-extractor";
import type { Text2ImageExecutorOptions, Text2ImageResult } from "./types";

const log = createLogger("P2.text2image");

/** 文件序号（进程级递增，用于生成不重复的文件名） */
let fileSeq = 0;

export class Text2ImageExecutor {
  private readonly p1Client: Text2ImageExecutorOptions["p1Client"];
  private readonly taskQueue: Text2ImageExecutorOptions["taskQueue"];
  private readonly botId: number;
  private readonly config: Text2ImageExecutorOptions["config"];
  private readonly systemPrompt: string;

  constructor(options: Text2ImageExecutorOptions) {
    this.p1Client = options.p1Client;
    this.taskQueue = options.taskQueue;
    this.botId = options.botId;
    this.config = options.config;
    this.systemPrompt = options.systemPrompt;

    // 确保输出目录存在
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    // 清理过期文件
    this.purgeOldFiles();

    log.info("text2image.executorReady", {
      baseUrl: this.config.baseUrl,
      promptModel: this.config.promptModel,
      imageModel: this.config.imageModel,
      imageSize: this.config.imageSize,
      outputDir: this.config.outputDir,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  主入口                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 执行文生图流程。
   *
   * @param call 提取到的 text2image 调用
   * @param groupId 触发群 ID
   * @param taskId 任务队列 ID（直接模式时为 undefined）
   */
  async execute(call: Text2ImageCall, groupId: number, taskId?: string): Promise<Text2ImageResult> {
    const startTime = Date.now();
    log.info("execute.start", { groupId, taskId, topic: call.topic });

    // 1. 校验主题
    const topic = (call.topic ?? "").trim();
    if (!topic) {
      const result: Text2ImageResult = { success: false, error: "主题为空", durationMs: Date.now() - startTime };
      this.failTask(taskId, result.error ?? "主题为空", groupId);
      return result;
    }

    // 2. 等待串行槽位（仅任务队列模式）
    if (taskId && this.taskQueue) {
      const acquired = await this.taskQueue.waitForRunning(taskId, 180000);
      if (!acquired) {
        const result: Text2ImageResult = {
          success: false,
          error: "等待执行槽位超时或任务已被取消",
          durationMs: Date.now() - startTime,
        };
        this.failTask(taskId, result.error ?? "等待超时", groupId);
        return result;
      }
    }

    // 3. Phase 1: 生成图片提示词
    let promptResult: { prompt: string; promptTokens: number; completionTokens: number; totalTokens: number };
    try {
      promptResult = await this.generatePrompt(topic);
      log.info("execute.promptGenerated", {
        groupId,
        taskId,
        promptLen: promptResult.prompt.length,
        tokens: promptResult.totalTokens,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute.promptFail", { groupId, taskId, error: errMsg });
      const errText = `提示词生成失败: ${errMsg}`;
      const result: Text2ImageResult = {
        success: false,
        error: errText,
        durationMs: Date.now() - startTime,
      };
      this.failTask(taskId, errText, groupId);
      return result;
    }

    // 4. Phase 2: 生成图片
    let imageUrl: string;
    try {
      imageUrl = await this.generateImage(promptResult.prompt);
      log.info("execute.imageGenerated", { groupId, taskId, imageUrl: imageUrl.slice(0, 80) });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute.imageGenFail", { groupId, taskId, error: errMsg });
      const errText = `图片生成失败: ${errMsg}`;
      const result: Text2ImageResult = {
        success: false,
        prompt: promptResult.prompt,
        promptTokens: promptResult.promptTokens,
        completionTokens: promptResult.completionTokens,
        totalTokens: promptResult.totalTokens,
        error: errText,
        durationMs: Date.now() - startTime,
      };
      this.failTask(taskId, errText, groupId);
      return result;
    }

    // 5. Phase 3: 下载图片到本地
    let imagePath: string;
    let imageBuffer: Buffer;
    try {
      const downloadResult = await this.downloadImage(imageUrl);
      imagePath = downloadResult.path;
      imageBuffer = downloadResult.buffer;
      log.info("execute.imageDownloaded", { groupId, taskId, path: imagePath, sizeBytes: imageBuffer.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute.downloadFail", { groupId, taskId, imageUrl, error: errMsg });
      const errText = `图片下载失败: ${errMsg}`;
      const result: Text2ImageResult = {
        success: false,
        prompt: promptResult.prompt,
        promptTokens: promptResult.promptTokens,
        completionTokens: promptResult.completionTokens,
        totalTokens: promptResult.totalTokens,
        error: errText,
        durationMs: Date.now() - startTime,
      };
      this.failTask(taskId, errText, groupId);
      return result;
    }

    // 6. Phase 4: 合并转发发送（图片 + 元数据两条消息在一个转发卡片中）
    const durationMs = Date.now() - startTime;
    const durationSec = (durationMs / 1000).toFixed(1);
    try {
      await this.sendAsForwardMessage(groupId, imagePath, topic, promptResult.totalTokens, durationSec);
      log.info("execute.forwardSent", { groupId, taskId, path: imagePath });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("execute.sendFail", { groupId, taskId, error: errMsg });
      const errText = `图片发送失败: ${errMsg}`;
      const result: Text2ImageResult = {
        success: false,
        imagePath,
        prompt: promptResult.prompt,
        promptTokens: promptResult.promptTokens,
        completionTokens: promptResult.completionTokens,
        totalTokens: promptResult.totalTokens,
        error: errText,
        durationMs,
      };
      this.failTask(taskId, errText, groupId);
      return result;
    }

    // 7. 完成
    if (taskId && this.taskQueue) {
      this.taskQueue.transition(taskId, "completed");
    }

    const result: Text2ImageResult = {
      success: true,
      imagePath,
      imageBuffer,
      prompt: promptResult.prompt,
      promptTokens: promptResult.promptTokens,
      completionTokens: promptResult.completionTokens,
      totalTokens: promptResult.totalTokens,
      durationMs,
    };

    log.info("execute.done", {
      groupId,
      taskId,
      durationMs,
      imagePath,
      totalTokens: promptResult.totalTokens,
    });

    return result;
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 1: LLM 提示词生成                                            */
  /* ------------------------------------------------------------------ */

  private async generatePrompt(topic: string): Promise<{
    prompt: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.config.promptModel,
      messages: [
        { role: "system", content: this.systemPrompt },
        { role: "user", content: `请为以下主题生成信息图提示词：${topic}` },
      ],
      stream: false,
    });

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: this.config.promptTimeoutMs,
    }, "promptGen");

    const data = JSON.parse(response) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(`LLM API 返回错误: ${data.error.message ?? JSON.stringify(data.error)}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content?.trim()) {
      throw new Error("LLM 未返回有效的提示词内容");
    }

    return {
      prompt: content.trim(),
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 2: 图片生成 API                                               */
  /* ------------------------------------------------------------------ */

  private async generateImage(prompt: string): Promise<string> {
    const url = `${this.config.baseUrl}/images/generations`;
    const body = JSON.stringify({
      model: this.config.imageModel,
      prompt,
      size: this.config.imageSize,
      n: 1,
    });

    const response = await this.fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: this.config.imageTimeoutMs,
    }, "imageGen");

    const data = JSON.parse(response) as {
      data?: Array<{ url?: string; b64_json?: string }>;
      error?: { message?: string };
    };

    if (data.error) {
      throw new Error(`图片生成 API 返回错误: ${data.error.message ?? JSON.stringify(data.error)}`);
    }

    const imageUrl = data.data?.[0]?.url;
    if (!imageUrl) {
      // 尝试 base64 格式
      const b64 = data.data?.[0]?.b64_json;
      if (b64) {
        // 将 base64 直接保存为文件
        const ext = this.detectImageExtension(b64);
        const filename = `t2i-${Date.now()}-${++fileSeq}.${ext}`;
        const filePath = path.join(this.config.outputDir, filename);
        fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
        return `file://${filePath}`; // 内部伪协议，回到 downloadImage 时处理
      }
      throw new Error("图片生成 API 未返回图片 URL 或 base64 数据");
    }

    return imageUrl;
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 3: 图片下载                                                   */
  /* ------------------------------------------------------------------ */

  private async downloadImage(imageUrl: string): Promise<{ path: string; buffer: Buffer }> {
    // 处理内部 file:// 伪协议（base64 已直接保存为文件）
    if (imageUrl.startsWith("file://")) {
      const filePath = imageUrl.slice(7);
      const buffer = fs.readFileSync(filePath);
      return { path: filePath, buffer };
    }

    const response = await this.fetchWithRetry(imageUrl, {
      method: "GET",
      timeoutMs: this.config.imageTimeoutMs,
    }, "imageDownload");

    const buffer = Buffer.from(response, "binary");
    const contentType = this.lastContentType ?? "image/png";
    const ext = this.contentTypeToExt(contentType);
    const filename = `t2i-${Date.now()}-${++fileSeq}.${ext}`;
    const filePath = path.join(this.config.outputDir, filename);

    fs.writeFileSync(filePath, buffer);
    log.info("downloadImage.saved", { url: imageUrl.slice(0, 60), path: filePath, sizeBytes: buffer.length });

    return { path: filePath, buffer };
  }

  /* ------------------------------------------------------------------ */
  /*  Phase 4: 合并转发发送（图片 + 元数据）                             */
  /* ------------------------------------------------------------------ */

  /**
   * 将图片和元数据打包为合并转发卡片发送。
   *
   * 转发卡片包含两条消息：
   *   Node 1: 生成的图片（image segment，base64）
   *   Node 2: 元数据文本（主题、尺寸、token消耗、耗时）
   */
  private async sendAsForwardMessage(
    groupId: number,
    imagePath: string,
    topic: string,
    totalTokens: number,
    durationSec: string,
  ): Promise<void> {
    // 读取图片并转 base64
    const imageBuffer = fs.readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString("base64");

    // 元数据文本
    const metadataLines: string[] = [
      `主题：${topic}`,
      `尺寸：${this.config.imageSize}`,
    ];
    if (totalTokens > 0) {
      metadataLines.push(`Token消耗：${totalTokens}`);
    }
    metadataLines.push(`耗时：${durationSec}s`);

    const forwardNodes = [
      {
        uin: this.botId,
        message: [{ type: "image", data: { file: `base64://${imageBase64}` } }],
      },
      {
        uin: this.botId,
        content: `[文生图]\n${metadataLines.join(" | ")}`,
      },
    ];

    await this.p1Client.request("send_message", {
      group_id: groupId,
      message: "",
      method: "forward",
      forward_nodes: forwardNodes,
    }, 30000);
  }

  /* ------------------------------------------------------------------ */
  /*  错误处理                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 标记任务失败，并发送错误消息到触发群。
   */
  private failTask(taskId: string | undefined, errorMsg: string, groupId: number): void {
    // 任务队列状态更新
    if (taskId && this.taskQueue) {
      this.taskQueue.transition(taskId, "failed", errorMsg);
    }

    // 发送错误消息到触发群
    const notifyText = `[文生图失败] ${errorMsg}`;
    this.p1Client.request("send_message", {
      group_id: groupId,
      message: notifyText,
    }, 10000).catch((err) => {
      log.error("failTask.sendErrorFail", { groupId, error: String(err) });
    });
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP 工具                                                          */
  /* ------------------------------------------------------------------ */

  private lastContentType: string | null = null;

  /**
   * 带重试的 fetch 封装。
   *
   * 与 SoVitsClient / LLMClient 保持一致的重试策略：
   * - 4xx → 不重试
   * - 5xx / 网络错误 / AbortError → 重试（最多 maxRetries 次）
   */
  private async fetchWithRetry(
    url: string,
    options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number },
    label: string,
  ): Promise<string> {
    const maxRetries = this.config.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs);

        const fetchOptions: RequestInit = {
          method: options.method ?? "POST",
          headers: options.headers,
          signal: controller.signal,
        };
        if (options.body) {
          fetchOptions.body = options.body;
        }

        const resp = await fetch(url, fetchOptions);
        clearTimeout(timer);

        // 保存 Content-Type 供图片下载使用
        const ct = resp.headers.get("content-type");
        if (ct) this.lastContentType = ct;

        if (!resp.ok) {
          const errorText = await resp.text().catch(() => "").then((t) => t.slice(0, 500));
          const err = new Error(`HTTP ${resp.status}${errorText ? `: ${errorText}` : ""}`);
          (err as unknown as Record<string, unknown>).status = resp.status;

          // 4xx → 不重试
          if (resp.status >= 400 && resp.status < 500) {
            throw err;
          }
          // 5xx → 重试
          lastError = err;
          if (attempt < maxRetries) {
            const delayMs = 1000 * Math.pow(2, attempt);
            log.warn(`fetch.retry.${label}`, { attempt: attempt + 1, status: resp.status, delayMs });
            await sleep(delayMs);
            continue;
          }
          throw err;
        }

        // 处理响应
        if (options.method === "GET" || url.endsWith(".png") || url.endsWith(".jpg") || url.endsWith(".webp")) {
          // 二进制响应（图片下载）
          const arrayBuffer = await resp.arrayBuffer();
          return Buffer.from(arrayBuffer).toString("binary");
        }

        return await resp.text();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new Error(`${label} 请求超时 (${options.timeoutMs}ms)`);
        } else if (err instanceof Error && (err as unknown as Record<string, unknown>).status) {
          // 已经是 4xx 错误，直接抛出
          throw err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        if (attempt < maxRetries) {
          const delayMs = 1000 * Math.pow(2, attempt);
          log.warn(`fetch.retry.${label}`, { attempt: attempt + 1, error: lastError.message, delayMs });
          await sleep(delayMs);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`${label} 请求失败（未知错误）`);
  }

  /* ------------------------------------------------------------------ */
  /*  工具方法                                                           */
  /* ------------------------------------------------------------------ */

  /** Content-Type → 文件扩展名 */
  private contentTypeToExt(contentType: string): string {
    if (contentType.includes("png")) return "png";
    if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
    if (contentType.includes("webp")) return "webp";
    return "png"; // 默认
  }

  /** 从 base64 魔数检测图片格式 */
  private detectImageExtension(b64: string): string {
    const head = b64.slice(0, 40);
    // PNG: iVBORw0KGgo
    if (head.startsWith("iVBORw0KGgo")) return "png";
    // JPEG: /9j/
    if (head.startsWith("/9j/")) return "jpg";
    // WebP: UklGR (RIFF)
    if (head.startsWith("UklGR")) return "webp";
    return "png";
  }

  /** 清理 outputDir 中超过 fileTtlMs 的旧文件 */
  private purgeOldFiles(): void {
    const dir = this.config.outputDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const cutoff = Date.now() - this.config.fileTtlMs;
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("t2i-")) continue;

      const filePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch (err) {
        log.warn("purgeOldFiles.skip", { path: filePath, error: String(err) });
      }
    }

    if (removed > 0) {
      log.info("purgeOldFiles.done", { dir, removed, remaining: entries.length - removed });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
