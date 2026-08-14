/**
 * Muri Agent 类型定义 — 子代理独立 LLM 循环的工具类型。
 */

import type { ForwardNode } from "../../common/types/ipc";

/** MuriAgentLoop 运行结果 */
export interface MuriAgentResult {
  /** 合并转发消息节点（含伪造身份） */
  forwardNodes: ForwardNode[];
  /** 错误信息（tool loop 全失败或 forgery 全失败时非空） */
  error?: string;
}

/** MuriAgentLoop 配置 */
export interface MuriAgentConfig {
  /** 最大工具调用轮次 */
  maxTurns: number;
  /** LLM 模型别名（传给 ConversationLoop 和 forgery relay.chatRaw） */
  model?: string;
}

/** 触发上下文（从 P2 传入，传递给 forgery 步骤） */
export interface MuriAgentContext {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 触发消息文本内容 */
  triggerText: string;
  /** 触发用户 ID */
  triggerUserId: number;
  /** 触发消息 ID */
  triggerMessageId: number;
  /** 群 ID */
  groupId: number;
  /** 主 agent 总结的任务概述 */
  task: string;
}

/** 角色 → user_id 映射 */
export interface RoleMapping {
  [roleName: string]: number;
}
