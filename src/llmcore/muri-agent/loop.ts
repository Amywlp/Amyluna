/**
 * MuriAgentLoop — 子代理 LLM 循环 + 聊天记录伪造。
 *
 * Phase 1: 复用 ConversationLoop 执行工具调用循环。
 *   中间过程不发送给用户，全部保留在 messages 中作为伪造步骤的上下文。
 *
 * Phase 2: 聊天记录伪造。
 *   使用 muri.yaml 预设，将完整上下文 + 角色设定 + 格式约束发给 LLM，
 *   生成 --- 分隔的结构化母女对话。
 *
 * Phase 3: 解析 LLM 输出 → ForwardNode[]。
 *   解析 --- 分隔的角色对话格式，映射角色名 → user_id。
 */

import { ConversationLoop } from "../conversation-loop";
import type { LLMRelay } from "../llm/relay";
import type { ToolRegistry } from "../tools/registry";
import type { ChatMessage, LLMResponse } from "../llm/types";
import type { ForwardNode } from "../../common/types/ipc";
import type { MuriAgentResult, MuriAgentConfig, MuriAgentContext, RoleMapping } from "./types";
import { retry } from "../../common/retry";
import { createLogger } from "../../common/logger";
import { logLLMResponse } from "../llm/llm-logger";

const log = createLogger("P3.muriAgent");

// ─── 默认角色映射（后续从配置或 preset 加载）──────────────

const DEFAULT_ROLE_MAP: RoleMapping = {
  "赫萝": 1000000000,
  "缪里": 1000000002,
};

// ─── 占位 system prompts（在未加载 preset 时使用）─────────

const MURI_AGENT_SYSTEM_PROMPT = `你是一个任务执行助手。根据用户描述的任务，使用可用工具完成它。

规则：
- 逐步执行任务，每次只调用一个工具
- 工具返回结果后，根据结果决定下一步
- 任务完成或无法继续时，停止调用工具并给出简要总结`;

// ─── 解析器：--- 分隔格式 ────────────────────────────────

/** 匹配 [角色名] 行 */
const ROLE_LINE_RE = /^\[([^\]]+)\]\s*$/;

/** 匹配 （动作描述） 行 */
const ACTION_LINE_RE = /^（[^）]*）\s*$/;

/**
 * 解析 LLM 输出的 --- 分隔角色对话格式。
 *
 * 格式:
 *   ---
 *   [角色名]
 *   （动作描述）
 *   言语内容
 *   ---
 *   [角色名]
 *   言语内容
 *
 * 角色名通过 roleMap 映射为 user_id，构造 ForwardNode。
 */
function parseDialogueToNodes(text: string, roleMap: RoleMapping): ForwardNode[] {
  const nodes: ForwardNode[] = [];

  // 清理可能的 markdown 代码块
  const cleaned = text
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/```$/gm, "")
    .trim();

  // 按 --- 分割消息块
  const blocks = cleaned.split(/\n---\n?/);

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split("\n");
    let idx = 0;

    // 第1行: [角色名]
    let roleLine = lines[idx]?.trim() ?? "";
    // 跳过可能的开头空行
    while (idx < lines.length && roleLine === "") {
      idx++;
      roleLine = lines[idx]?.trim() ?? "";
    }
    const roleMatch = roleLine.match(ROLE_LINE_RE);
    if (!roleMatch) {
      log.warn("parse.noRoleLine", { line: roleLine.slice(0, 50) });
      continue;
    }
    const roleName = roleMatch[1]!.trim();
    const user_id = roleMap[roleName];
    if (!user_id) {
      log.warn("parse.unknownRole", { role: roleName, knownRoles: Object.keys(roleMap) });
      continue;
    }
    idx++;

    // 第2行（可选）: （动作描述）
    let actionText = "";
    if (idx < lines.length) {
      const actionLine = lines[idx]?.trim() ?? "";
      if (actionLine && ACTION_LINE_RE.test(actionLine)) {
        actionText = actionLine;
        idx++;
      }
    }

    // 剩余行: 言语内容
    const speechLines: string[] = [];
    while (idx < lines.length) {
      const line = lines[idx]!.trim();
      if (line) speechLines.push(line);
      idx++;
    }
    const speech = speechLines.join("\n").trim();

    if (!speech) {
      log.warn("parse.emptySpeech", { role: roleName });
      continue;
    }

    // 组装 content: 动作 + 言语
    const content = actionText ? `${actionText}\n${speech}` : speech;

    nodes.push({
      uin: user_id,
      name: roleName,
      content,
    });
  }

  return nodes;
}

// ─── 日志辅助 ──────────────────────────────────────────

function logForgeryError(context: { attempt: number; error: string; msgCount: number }): void {
  const errorResponse: LLMResponse = {
    content: null,
    finishReason: "error",
    usage: undefined,
  };
  logLLMResponse(errorResponse, { turn: -1 - context.attempt, msgCount: context.msgCount });
}

/**
 * 从 MuriAgentContext 构造 forgery 步骤的 user 消息。
 * 包含触发消息完整信息、时间戳、任务概述，以及格式提醒。
 */
function buildForgeryUserPrompt(ctx: MuriAgentContext): string {
  const date = new Date(ctx.timestamp);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const fullDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

  return [
    `触发时间: ${fullDate} ${hhmm}`,
    `触发用户: ${ctx.triggerUserId}`,
    `触发消息: ${ctx.triggerText || "(无文本)"}`,
    `任务概述: ${ctx.task}`,
    ``,
    `请基于以上信息和工具执行记录，生成一段赫萝与缪里的母女对话。`,
    `对话中赫萝将任务自然转述给缪里，缪里接任务、执行、汇报结果。`,
    ``,
    `【重要】请严格遵循 system prompt 中定义的输出格式：`,
    `- 使用 "---" 分隔每条消息`,
    `- 每条消息以 [角色名] 开头，可选（动作描述），然后是言语内容`,
    `- 角色名仅限 "赫萝" 或 "缪里"`,
    `- 只输出格式化的对话，不要输出任何额外的解释或说明`,
  ].join("\n");
}

// ─── MuriAgentLoop ─────────────────────────────────────

export class MuriAgentLoop {
  /** forgery 步骤使用的 system prompt（从 muri.yaml 加载） */
  private forgerySystemPrompt: string;

  /** 角色 → user_id 映射 */
  private roleMap: RoleMapping;

  constructor(
    private readonly relay: LLMRelay,
    private readonly qqFunRegistry: ToolRegistry,
    private readonly config: MuriAgentConfig,
    forgeryPresetBody?: string,
    roleMap?: RoleMapping,
  ) {
    this.forgerySystemPrompt = forgeryPresetBody || "";
    this.roleMap = roleMap ?? DEFAULT_ROLE_MAP;
  }

  /**
   * 运行 muri_agent 完整流程。
   *
   * @param userContext Phase 1 的 user prompt（任务执行上下文）
   * @param muriContext Phase 2 的触发上下文（含时间戳、触发消息等）
   */
  async run(userContext: string, muriContext: MuriAgentContext): Promise<MuriAgentResult> {
    // ═══════════════════════════════════════════════════════
    // Phase 1: Tool Call 循环
    // ═══════════════════════════════════════════════════════
    const messages: ChatMessage[] = [
      { role: "system", content: MURI_AGENT_SYSTEM_PROMPT },
      { role: "user", content: userContext },
    ];

    const loop = new ConversationLoop(this.relay, this.qqFunRegistry, this.config.maxTurns, this.config.model);
    // 不设置 onIntermediateReply → 中间文本不发送

    try {
      await loop.run(messages);
      log.info("toolLoop.done", { msgCount: messages.length });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("toolLoop.error", { error: errMsg, msgCount: messages.length });
      messages.push({
        role: "user",
        content: `[系统提示: 任务执行过程中出现错误: ${errMsg}。请根据已获取的信息尽可能生成聊天记录。]`,
      });
    }

    // ═══════════════════════════════════════════════════════
    // Phase 2: 聊天记录伪造（使用 muri.yaml preset）
    // ═══════════════════════════════════════════════════════
    const forgerySystemPrompt = this.forgerySystemPrompt || this.buildFallbackForgeryPrompt();

    const forgeryMessages: ChatMessage[] = [
      { role: "system", content: forgerySystemPrompt },
      // 过滤掉 Phase 1 的 system prompt，保留执行过程
      ...messages.filter((m) => m.role !== "system"),
      { role: "user", content: buildForgeryUserPrompt(muriContext) },
    ];

    let forgeryContent: string | null = null;
    let forgeryResponse: LLMResponse | null = null;
    try {
      forgeryContent = await retry(
        async () => {
          const resp = await this.relay.chatRaw(forgeryMessages, undefined, this.config.model);
          forgeryResponse = resp;
          if (!resp.content) {
            throw new Error("LLM 返回空内容");
          }
          return resp.content;
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 4000,
          onRetry: (attempt, error) => {
            log.warn("forgery.retry", { attempt, error: error.message });
            if (forgeryResponse) {
              logLLMResponse(forgeryResponse, { turn: -attempt, msgCount: forgeryMessages.length });
            }
          },
        },
      );
      // 记成功日志
      if (forgeryResponse) {
        logLLMResponse(forgeryResponse, { turn: 0, msgCount: forgeryMessages.length });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("forgery.exhausted", { error: errMsg });
      if (forgeryResponse) {
        logLLMResponse(forgeryResponse, { turn: -3, msgCount: forgeryMessages.length });
      } else {
        logForgeryError({ attempt: 3, error: errMsg, msgCount: forgeryMessages.length });
      }
      return { forwardNodes: [], error: `聊天记录生成失败: ${errMsg}` };
    }

    // ═══════════════════════════════════════════════════════
    // Phase 3: 解析 → ForwardNode[]
    // ═══════════════════════════════════════════════════════
    const forwardNodes = parseDialogueToNodes(forgeryContent, this.roleMap);

    if (forwardNodes.length === 0) {
      log.warn("parse.empty", { contentPreview: forgeryContent.slice(0, 300) });
      return { forwardNodes: [], error: "聊天记录解析失败：未能提取有效消息" };
    }

    log.info("done", { nodeCount: forwardNodes.length });
    return { forwardNodes };
  }

  /**
   * 构建 fallback forgery prompt（在未加载 muri.yaml preset 时使用）。
   * 包含最基本的格式约束，确保输出可解析。
   */
  private buildFallbackForgeryPrompt(): string {
    return `你是一个对话生成器。根据上下文生成赫萝与缪里的母女对话。

## 输出格式（严格遵守）

每条消息以 "---" 分隔，格式为：

---
[赫萝]
（可选的动作描述）
言语内容（纯文本，最多80字）

---
[缪里]
言语内容

## 格式约束
- 角色名仅允许 [赫萝] 或 [缪里]，方括号半角
- 动作描述用中文全角圆括号（），可省略
- "---" 独占一行，前后无空格
- 每条消息至少包含一行言语
- 禁止输出代码块标记或任何额外解释

## 角色映射
- 赫萝 → user_id: 1000000000
- 缪里 → user_id: 1000000002`;
  }
}
