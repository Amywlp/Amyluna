/**
 * text2image 模块类型定义。
 *
 * Text2ImageExecutor 接收主 agent 传入的主题描述，
 * 先调用 LLM 生成结构化图片提示词，再调用图片生成 API，
 * 最后下载图片并通过 P1 发送到 QQ 群。
 */

import type { IpcClient } from "../../common/ipc/client";
import type { TaskQueueManager } from "../task-queue-manager";
import type { Text2ImageConfig } from "../../common/config";

/** text2image 执行结果 */
export interface Text2ImageResult {
  success: boolean;
  /** 图片文件绝对路径（成功时） */
  imagePath?: string;
  /** 图片字节（成功时） */
  imageBuffer?: Buffer;
  /** LLM 生成的图片提示词 */
  prompt?: string;
  /** 提示词生成消耗的 prompt tokens */
  promptTokens?: number;
  /** 提示词生成消耗的 completion tokens */
  completionTokens?: number;
  /** 提示词生成总 token 消耗 */
  totalTokens?: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 总耗时（ms） */
  durationMs: number;
}

/** Text2ImageExecutor 构造选项 */
export interface Text2ImageExecutorOptions {
  /** → P1: 发送 send_message */
  p1Client: IpcClient;
  /** 任务队列管理器（用于串行调度和生命周期追踪） */
  taskQueue: TaskQueueManager | null;
  /** bot QQ 号 */
  botId: number;
  /** 配置 */
  config: Text2ImageConfig;
  /** 文生图系统预设（从 text2image.yaml 加载） */
  systemPrompt: string;
}
