/**
 * SoVitsClient — GPT-SoVITS v2Pro TTS API 客户端。
 *
 * POST /tts → 返回 raw WAV bytes。
 * 超时 120s（AbortController），网络/5xx 重试 1 次，4xx 不重试。
 * 校验响应: RIFF + WAVE magic bytes。
 */

import { createLogger } from "../../common/logger";
import type { SynthesizeRequest, InferenceParams } from "./types";

const log = createLogger("P2.tts.client");

/** WAV RIFF 头校验: RIFF....WAVE */
const WAV_MAGIC_PATTERN = /^RIFF....WAVE/s;

/** 默认推理参数（对齐 batch_multi_seed.py call_tts） */
const DEFAULT_INFERENCE: InferenceParams = {
  speedFactor: 0.95,
  topK: 10,
  topP: 15,
  temperature: 0.8,
  repetitionPenalty: 1.0,
  textSplitMethod: "cut3",
  fragmentInterval: 0.3,
  sampleSteps: 32,
  superSampling: false,
  parallelInfer: true,
  batchSize: 1,
  batchThreshold: 0.75,
  splitBucket: true,
  streamingMode: false,
  mediaType: "wav",
};

export class SoVitsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 120000,
    private readonly maxRetries: number = 1,
  ) {}

  /** 设置 GPT 模型权重（调用 /set_gpt_weights） */
  async setGptWeights(weightsPath: string): Promise<void> {
    const url = `${this.baseUrl}/set_gpt_weights?weights_path=${encodeURIComponent(weightsPath)}`;
    log.debug("tts.setGptWeights", { path: weightsPath.slice(-40) });
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`set_gpt_weights failed: ${response.status} ${text.slice(0, 200)}`);
    }
  }

  /** 设置 SoVITS 模型权重（调用 /set_sovits_weights） */
  async setSovitsWeights(weightsPath: string): Promise<void> {
    const url = `${this.baseUrl}/set_sovits_weights?weights_path=${encodeURIComponent(weightsPath)}`;
    log.debug("tts.setSovitsWeights", { path: weightsPath.slice(-40) });
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`set_sovits_weights failed: ${response.status} ${text.slice(0, 200)}`);
    }
  }

  /**
   * 调用 TTS API 合成语音，返回 WAV Buffer。
   *
   * @throws {Error} API 不可用 / 超时 / 响应非 WAV
   */
  async synthesize(req: SynthesizeRequest): Promise<Buffer> {
    // 0. 设置模型权重（如果指定了）
    if (req.gptModelPath) {
      await this.setGptWeights(req.gptModelPath);
    }
    if (req.sovitsModelPath) {
      await this.setSovitsWeights(req.sovitsModelPath);
    }

    // 合并推理参数：VoiceConfig 默认值 < DEFAULT_INFERENCE < 请求覆盖
    const inf = req.inference ?? {};
    const url = `${this.baseUrl}/tts`;
    const body = JSON.stringify({
      text: req.text,
      text_lang: req.textLang,
      ref_audio_path: req.refAudioPath,
      prompt_lang: req.promptLang,
      prompt_text: req.promptText || "",
      speed_factor: inf.speedFactor ?? DEFAULT_INFERENCE.speedFactor,
      top_k: inf.topK ?? DEFAULT_INFERENCE.topK,
      top_p: inf.topP ?? DEFAULT_INFERENCE.topP,
      temperature: inf.temperature ?? DEFAULT_INFERENCE.temperature,
      repetition_penalty: inf.repetitionPenalty ?? DEFAULT_INFERENCE.repetitionPenalty,
      text_split_method: inf.textSplitMethod ?? DEFAULT_INFERENCE.textSplitMethod,
      fragment_interval: inf.fragmentInterval ?? DEFAULT_INFERENCE.fragmentInterval,
      seed: req.seed ?? Math.floor(Math.random() * 2147483647),
      sample_steps: inf.sampleSteps ?? DEFAULT_INFERENCE.sampleSteps,
      super_sampling: inf.superSampling ?? DEFAULT_INFERENCE.superSampling,
      parallel_infer: inf.parallelInfer ?? DEFAULT_INFERENCE.parallelInfer,
      batch_size: inf.batchSize ?? DEFAULT_INFERENCE.batchSize,
      batch_threshold: inf.batchThreshold ?? DEFAULT_INFERENCE.batchThreshold,
      split_bucket: inf.splitBucket ?? DEFAULT_INFERENCE.splitBucket,
      streaming_mode: inf.streamingMode ?? DEFAULT_INFERENCE.streamingMode,
      media_type: inf.mediaType ?? DEFAULT_INFERENCE.mediaType ?? "wav",
      aux_ref_audio_paths: req.auxRefAudioPaths ?? [],
    });

    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        log.warn("tts.retry", { attempt, lastError: lastError?.message });
        // 短暂等待后重试
        await sleep(1000);
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));

        // 4xx 不重试
        if (response.status >= 400 && response.status < 500) {
          const errorText = await response.text().catch(() => "");
          throw new Error(`TTS API ${response.status}: ${errorText.slice(0, 200)}`);
        }

        // 5xx 重试
        if (!response.ok) {
          throw new Error(`TTS API ${response.status}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());

        // 校验 WAV 格式
        const header = buffer.slice(0, 12).toString("latin1");
        if (!WAV_MAGIC_PATTERN.test(header)) {
          const preview = buffer.slice(0, 16).toString("hex");
          throw new Error(`TTS response is not valid WAV (header: ${preview})`);
        }

        const durationMs = Date.now() - startTime;
        log.info("tts.synthesize.done", { textLen: req.text.length, lang: req.textLang, sizeBytes: buffer.length, durationMs, attempts: attempt + 1 });
        return buffer;

      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // AbortError → 超时，重试
        if (lastError.name === "AbortError") {
          lastError = new Error(`TTS API timeout after ${this.timeoutMs}ms`);
        }
      }
    }

    const durationMs = Date.now() - startTime;
    log.error("tts.synthesize.fail", { textLen: req.text.length, durationMs, error: lastError?.message });
    throw lastError ?? new Error("TTS synthesis failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
