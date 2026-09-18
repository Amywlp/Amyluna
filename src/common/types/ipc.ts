/**
 * IPC 消息类型定义。
 * TCP JSON 行协议（\n 分隔），支持 request-response。
 */

// ─── IPC 消息类型枚举 ──────────────────────────────────

export type IpcType = string;

// ─── IPC 消息格式 ──────────────────────────────────────

export interface IpcMessage {
  type: IpcType;
  payload: unknown;
  request_id?: string;
}

// ─── P1 ← P2 的具体 Payload ───────────────────────────

/** P1 → P2: 触发对话 */
export interface TriggerPayload {
  group_id: number;
  message_id: number;
  /** 触发原因：at | reply | keyword | prd（随机插嘴） */
  reason?: string;
  /** OneBot 消息发送时间（Unix 秒） */
  time?: number;
}

/** 合并转发消息节点（P2 → P1） */
export interface ForwardNode {
  name?: string;
  uin?: number;
  user_id?: number;
  content?: string | Array<{ type: string; data: Record<string, unknown> }>;
  /** OneBot message 格式（支持 MessageSegment[] 数组） */
  message?: string | Array<{ type: string; data: Record<string, unknown> }>;
}

/** P2 → P1: 发送消息委托 */
export interface SendMessagePayload {
  group_id: number;
  message: string;
  method?: "normal" | "forward";
  /** memesluna 表情图片 URL（P1 负责下载并转为 CQ image segment） */
  meme_url?: string;
  /** 合并转发节点（method="forward" 时必填，整条消息作为一个节点） */
  forward_nodes?: ForwardNode[];
  /** TTS 音频文件绝对路径（P1 负责读取→base64→发送 record 消息） */
  tts_audio?: string;
  /** text2image 生成的图片绝对路径（P1 负责读取→base64→发送 image 消息） */
  image_path?: string;
}

/** P2 → P1: 发送消息结果（request-response） */
export interface SendMessageResultPayload {
  message_id: number;
}

/** P3 → P1: 错误告警 */
export interface ErrorAlertPayload {
  group_id: number;
  message: string;
}

/** P1 → P3: 视觉识别请求 */
export interface VisionPayload {
  image_urls: string[];
  group_id?: number;
  message_id?: number;
}

/** P3 → P1: 视觉识别结果 */
export interface VisionResultPayload {
  descriptions: string[];
}

// ─── P2 ↔ P3 的具体 Payload ───────────────────────────

/** P2 → P3: 对话请求 */
export interface ChatPayload {
  context: string;
  preset: string;
  group_id: number;
  message_id: number;
  /** 触发消息的发送者 QQ 号 */
  user_id?: number;
  /** 触发消息的发送时间（OneBot Unix 秒） */
  time?: number;
  /** 触发用户的有效好感度（1-100），用于 context_review 等工具校验权限 */
  affinity?: number;
}

/** P2 → P3: muri_agent 子代理请求 */
export interface MuriAgentPayload {
  group_id: number;
  /** 触发消息的用户 ID */
  user_id: number;
  /** 触发消息的 message_id */
  message_id: number;
  /** 触发消息的完整文本内容 */
  trigger_text: string;
  /** 触发时间戳（ISO 8601），用于对话场景时间判断 */
  timestamp: string;
  /** 主 agent 总结的任务概述 */
  task: string;
}

/** 静默工具调用（P3 识别，P2 执行） */
export interface SilentToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** P3 → P2: 对话响应 */
export interface ChatResponsePayload {
  group_id: number;
  message_id: number;
  content: string;
  silent_tool_calls?: SilentToolCall[];
}

/** P3 → P2: muri_agent 子代理响应 */
export interface MuriAgentResponsePayload {
  group_id: number;
  /** 合并转发消息节点（含伪造身份） */
  forward_nodes: ForwardNode[];
  /** 错误信息（tool loop 全失败或 forgery 全失败时） */
  error?: string;
}

/** P3 → P2: 中间回复（每次 LLM turn 的输出，在工具执行前发送） */
export interface IntermediateReplyPayload {
  group_id: number;
  message_id: number;
  content: string;
}

/** P3 → P1: QQ 互动操作请求（muri_agent QQ fun tools） */
export interface QqActionPayload {
  /** OneBot action 名称 */
  action: "send_like" | "send_poke" | "group_poke" | "set_group_reaction" | "get_group_file_url" | "send_group_msg";
  /** action 参数 */
  params: Record<string, unknown>;
}

/** P1 → P3: QQ 互动操作结果 */
export interface QqActionResultPayload {
  success: boolean;
  error?: string;
  result?: Record<string, unknown>;
}

/** P3 → P1: temp_mute 临时禁言请求 */
export interface TempMutePayload {
  user_id: number;
  mute_time: number;
  severe_level: number;
}

/** P1 → P3: temp_mute 临时禁言结果 */
export interface TempMuteResultPayload {
  success: boolean;
  /** 禁言结束时间（Unix 秒） */
  muted_until?: number;
  /** 实际禁言时长（秒）= mute_time × severe_level */
  actual_duration?: number;
  error?: string;
}

// ─── 类型守卫 ──────────────────────────────────────────

export type IpcPayloadMap = {
  trigger: TriggerPayload;
  chat: ChatPayload;
  chat_response: ChatResponsePayload;
  muri_agent: MuriAgentPayload;
  muri_agent_response: MuriAgentResponsePayload;
  intermediate_reply: IntermediateReplyPayload;
  send_message: SendMessagePayload;
  send_message_result: SendMessageResultPayload;
  qq_action: QqActionPayload;
  qq_action_result: QqActionResultPayload;
  temp_mute: TempMutePayload;
  temp_mute_result: TempMuteResultPayload;
  error_alert: ErrorAlertPayload;
  vision: VisionPayload;
  vision_result: VisionResultPayload;
  ping: null;
  pong: null;
  [key: string]: unknown;
};
