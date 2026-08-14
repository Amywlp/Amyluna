/**
 * TTS 模块类型定义。
 */

import type { IpcClient } from "../../common/ipc/client";
import type { TaskQueueManager } from "../task-queue-manager";
import type { TtsCall } from "../silent-text-extractor";
import type { VoiceRegistry } from "./voices";
import type { SoVitsClient } from "./so-vits-client";

/** 支持的语言标签 */
export type TtsLang = "zh" | "en" | "ja" | "ko" | "yue" | "auto";

/** TTS 发送模式 */
export type TtsSendMode = "sequential" | "forward-audio" | "forward-video";

/** 合法语言集合 */
export const VALID_TTS_LANGS: ReadonlySet<string> = new Set(["zh", "ja", "en", "ko", "yue", "auto"]);

/** 语音角色配置（从 {voice}_infer_config.json 加载） */
export interface VoiceConfig {
  /** 角色名称 */
  name: string;
  /** 参考音频路径 */
  refAudioPath: string;
  /** 提示语言 */
  promptLang: string;
  /** 提示文本 */
  promptText: string;
  /** 辅助参考音频路径（跨语言合成用） */
  auxRefAudioPaths?: string[];
  /** GPT 模型权重路径（不传则用 API 默认值） */
  gptModelPath?: string;
  /** SoVITS 模型权重路径（不传则用 API 默认值） */
  sovitsModelPath?: string;
  /** 推理参数（对齐 batch_multi_seed.py call_tts） */
  inference: InferenceParams;
}

/** SoVITS 推理参数（对齐 batch_multi_seed.py） */
export interface InferenceParams {
  textLang?: string;
  speedFactor?: number;
  topK?: number;
  topP?: number;
  temperature?: number;
  repetitionPenalty?: number;
  textSplitMethod?: string;
  fragmentInterval?: number;
  sampleSteps?: number;
  superSampling?: boolean;
  parallelInfer?: boolean;
  batchSize?: number;
  batchThreshold?: number;
  splitBucket?: boolean;
  streamingMode?: boolean;
  mediaType?: string;
}

/** SoVITS 合成请求 */
export interface SynthesizeRequest {
  text: string;
  textLang: string;
  refAudioPath: string;
  promptLang: string;
  promptText: string;
  /** 推理覆盖（可选，不传则用 VoiceConfig 默认值） */
  inference?: Partial<InferenceParams>;
  seed?: number;
  auxRefAudioPaths?: string[];
  /** GPT 模型权重路径（不传则不切换） */
  gptModelPath?: string;
  /** SoVITS 模型权重路径（不传则不切换） */
  sovitsModelPath?: string;
}

/** TTS 执行结果 */
export interface TtsResult {
  /** 合成成功 */
  success: boolean;
  /** WAV 文件路径（成功时） */
  audioPath?: string;
  /** WAV 音频字节（成功时） */
  audioBuffer?: Buffer;
  /** 错误信息（失败时） */
  error?: string;
  /** 合成耗时（ms） */
  durationMs: number;
}

/** TtsExecutor 构造选项 */
export interface TtsExecutorOptions {
  /** → P1 IPC 客户端（发送消息到 QQ） */
  p1Client: IpcClient;
  /** 任务队列管理器（串行槽位管理） */
  taskQueue: TaskQueueManager | null;
  /** bot QQ 号 */
  botId: number;
  /** 语音注册表 */
  registry: VoiceRegistry;
  /** SoVITS HTTP 客户端 */
  client: SoVitsClient;
  /** 音频输出目录 */
  outputDir: string;
  /** 默认语言 */
  defaultLang: string;
  /** 最大文本长度 */
  maxTextLen: number;
  /** 文件保留时间（ms） */
  fileTtlMs: number;
  /** 发送模式 */
  sendMode: TtsSendMode;
}
