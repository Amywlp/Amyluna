/**
 * 静默工具体 definition（block 型）— 注册进 P3 ToolRegistry 供模型通过
 * function calling 触发，但 P3 不执行：conversation-loop 识别 block=true 后
 * 收集为 silentToolCalls 交回 P2（src/convmgr/）由既有 executor + 任务托管执行。
 *
 * 调用约束（写入各自 description，配合 preset 双保险）：
 * - 调用轮即最终回复轮：调用时输出的正文会直接发送给用户，系统不会等待工具
 *   结果、也不会再开一轮补全，因此必须同时输出完整、面向用户的最终回复。
 * - 同一轮可同时调用多个不同的静默工具；同一工具一轮只应调用一次。
 *
 * execute 仅为占位：若被 P3 直接执行（不应发生）则返回错误。
 */
import type { ToolMeta } from "../types";

function silentTool(definition: ToolMeta["definition"]): ToolMeta {
  return {
    definition,
    execute: async () => ({ error: "静默工具由 P2 执行，P3 不应直接调用本工具。" }),
    requiresFollowUp: false,
    block: true,
    timeout: 1000,
  };
}

/** timer —— 设定定时提醒 */
export const timerTool: ToolMeta = silentTool({
  type: "function",
  function: {
    name: "timer",
    description:
      "设置定时提醒：到时间后系统会 @ 触发用户并发送提醒文本到群里。调用轮即最终回复轮——本轮输出的正文会直接发送给用户，不会等待结果也不会再开一轮，因此调用时必须同时给出完整、面向用户的最终回复（如告知已设定提醒）。同一轮只调用本工具一次。时长下限 60 秒（不足按 60 秒），上限 86400 秒（超限无效）。",
    parameters: {
      type: "object",
      properties: {
        duration_sec: {
          type: "number",
          description: "提醒延迟秒数，最小 60，最大 86400（24 小时）",
        },
        event_text: {
          type: "string",
          description: "提醒事件文本，如：喝水 / 关火 / 开会 / 吃药",
        },
      },
      required: ["duration_sec", "event_text"],
    },
  },
});

/** tts —— 语音合成 */
export const ttsTool: ToolMeta = silentTool({
  type: "function",
  function: {
    name: "tts",
    description:
      "语音合成：将指定文本合成为赫萝语音发送到群里（音频+原文+中文翻译，多条消息）。调用轮即最终回复轮——本轮输出的正文会直接发送给用户，不会等待合成结果也不会再开一轮，因此调用时必须同时给出完整、面向用户的最终回复。同一轮只调用本工具一次。文本 ≤100 字。语言标签：zh 中文 / ja 日语（默认赫萝本色嗓音）/ en / ko / yue；非中文必须提供中文翻译。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待合成语音的文本，保持赫萝口吻，10-60 字为宜" },
        lang: {
          type: "string",
          enum: ["zh", "ja", "en", "ko", "yue"],
          description: "语言标签，默认 ja（日语，赫萝本色嗓音）；语言标签必须与正文实际语言一致",
        },
        translation: { type: "string", description: "中文翻译（非中文时必填）" },
      },
      required: ["text"],
    },
  },
});

/** muri_agent —— 委托子代理缪里执行 QQ 平台操作 */
export const muriAgentTool: ToolMeta = silentTool({
  type: "function",
  function: {
    name: "muri_agent",
    description:
      "委托子代理缪里（muri agent）执行 QQ 平台原生操作（拍一拍、点赞、表情回应等），完成后以合并转发卡片形式展示母女对话过程。调用轮即最终回复轮——本轮输出的正文会直接发送给用户，不会等待子代理结果也不会再开一轮，因此调用时必须同时给出面向用户的最终回复。同一轮只调用本工具一次。仅在明确需要 QQ 平台操作时使用。任务描述需清晰完整（目标用户 QQ 号从上下文消息前缀获取）。",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "要执行的具体操作描述，含目标用户 QQ 号与动作，如：戳一下用户 123456789" },
      },
      required: ["task"],
    },
  },
});

/** text2image —— 文生图 */
export const text2ImageTool: ToolMeta = silentTool({
  type: "function",
  function: {
    name: "text2image",
    description:
      "文生图：根据主题描述生成图片发送到群里（图片+元数据合并转发）。调用轮即最终回复轮——本轮输出的正文会直接发送给用户，不会等待图片生成也不会再开一轮，因此调用时必须同时给出完整、面向用户的最终回复。同一轮只调用本工具一次。主题 ≤200 字；用户好感度低于 60 或语气不佳时不要调用。",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "图片主题描述（1-3 句话：主体 + 风格 + 氛围，信息图则含核心要点）" },
      },
      required: ["topic"],
    },
  },
});

/** 全部静默工具体注册清单 */
export const silentToolDefinitions: ToolMeta[] = [
  timerTool,
  ttsTool,
  muriAgentTool,
  text2ImageTool,
];