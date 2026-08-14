# Muri Agent 设计文档

## 概述

Muri Agent 是 amyluna v2 的串行静默子代理，由主 agent 通过文本标记 `muri_agent("任务概述")` 分发任务触发。其目的是为主 agent 完成 QQ 平台原生功能（戳一戳、拉黑等），节省主 agent preset 长度，让主 agent 聚焦对话。

**核心特征**：
- 串行静默工具，主 agent 触发后不等待返回
- 拥有独立的 tool call 循环和消息发送能力
- 中间过程不发送给用户，全部保留为聊天记录伪造的上下文
- 最终以合并转发卡片形式发送，使用深度身份伪装

---

## 消息链路

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          主 Agent 分发任务                                │
│                                                                          │
│  用户: "帮我戳一下小明"                                                    │
│    → P1 trigger → P2 handleTrigger() → P3 ConversationLoop               │
│    → 主 agent LLM 输出: "好的~muri_agent("戳一下小明，uid:123456")~"       │
│    → P3 返回 { content, silent_tool_calls: [] }                          │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                     P2 — 静默工具提取与分流                                │
│                                                                           │
│  extractSilentCalls(text, triggerUserId, triggerMsgId)                    │
│    ├── 模块: src/convmgr/silent-text-extractor.ts                         │
│    ├── 正则: /muri_agent\("([^"]*)"\)/g                                  │
│    ├── 取最后一条有效调用                                                    │
│    ├── 清洗: 从文本中移除 muri_agent(...) 标记                              │
│    └── 返回: MuriAgentCall { task, userId, messageId }                    │
│                                                                           │
│  SilentToolExecutor.executeExtracted(extracted, groupId, triggerUserId)   │
│    ├── 模块: src/convmgr/silent-tools.ts                                  │
│    └── 分流:                                                              │
│          ├── shouldQueue("muri_agent") → executeMuriAgentQueued()         │
│          │     └── TaskQueueManager.enqueue("muri_agent", ...)            │
│          │           ├── 模块: src/convmgr/task-queue-manager.ts          │
│          │           ├── 串行: FIFO 槽位锁，前一个完成才触发下一个           │
│          │           └── 出队 → MuriAgentExecutor.execute()               │
│          └── !shouldQueue → executeMuriAgentDirect()                      │
│                └── MuriAgentExecutor.execute()                            │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   ↓
┌──────────────────────────────────────────────────────────────────────────┐
│                   P2 — MuriAgentExecutor                                  │
│                   模块: src/convmgr/muri-agent/executor.ts                │
│                                                                           │
│  execute(call: MuriAgentCall, groupId: number)                            │
│    ├── 1. repo.findByMessageId(call.messageId) → 获取触发消息文本          │
│    │      模块: src/common/db/message-repository.ts                       │
│    ├── 2. 构造上下文:                                                      │
│    │       - 触发消息: {triggerText}                                       │
│    │       - 触发用户ID: {call.userId}                                    │
│    │       - 任务: {call.task}                                            │
│    ├── 3. p3Client.request("muri_agent", {...}, 120000)                   │
│    │      模块: src/common/ipc/client.ts                                  │
│    │      IPC: P2 → P3, request-response                                 │
│    ├── 4. taskQueue.transition(taskId, "completed")                       │
│    │      模块: src/convmgr/task-queue-manager.ts                         │
│    └── 5. p1Client.request("send_message", { method:"forward", ...})      │
│           模块: src/common/ipc/client.ts                                  │
│           → P1 sendGroupForwardMessage()                                  │
│             模块: src/receiver/send-api.ts                                │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   ↓  IPC: muri_agent (P2→P3)
┌──────────────────────────────────────────────────────────────────────────┐
│                      P3 — MuriAgentLoop                                   │
│                    模块: src/llmcore/muri-agent/loop.ts                   │
│                                                                           │
│  run(userContext: string): Promise<MuriAgentResult>                       │
│    ├── Phase 1: Tool Call 循环                                            │
│    │   ├── 复用 ConversationLoop (src/llmcore/conversation-loop.ts)       │
│    │   ├── tools = QQ fun ToolRegistry (当前空，预留)                       │
│    │   │     模块: src/llmcore/tools/registry.ts                          │
│    │   ├── onIntermediateReply = 未设置 → 中间文本不发送，保留在 messages   │
│    │   ├── messages 累积: [system, user, assistant+tool_calls,            │
│    │   │                   tool_results, assistant+tool_calls, ...]       │
│    │   └── loopResult = { content, silentToolCalls }                      │
│    │                                                                      │
│    ├── Phase 2: 聊天记录伪造                                               │
│    │   ├── 过滤 messages (去掉原 system prompt)                            │
│    │   ├── 拼接 forgery system prompt (硬编码占位，后续换 YAML preset)      │
│    │   ├── forgeryMessages = [system(forgery), ...filteredMessages,       │
│    │   │                      user("请基于以上对话过程生成聊天记录")]        │
│    │   ├── retry(relay.chatRaw, 3次, 指数退避1s→2s→4s)                      │
│    │   │     模块: src/common/retry.ts + src/llmcore/llm/relay.ts         │
│    │   ├── 每次重试失败 → logLLMResponse (finishReason:"error")             │
│    │   └── → forgeryContent (结构化聊天记录文本) 或 全失败→error             │
│    │                                                                      │
│    └── Phase 3: 解析 → ForwardNode[]                                      │
│        ├── 解析格式: [user_id:QQ|name:昵称] 消息内容                        │
│        └── 返回 MuriAgentResult { forwardNodes }                          │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   ↓  IPC: muri_agent_response (P3→P2)
┌──────────────────────────────────────────────────────────────────────────┐
│                      P1 — 合并转发发送                                     │
│                    模块: src/receiver/send-api.ts                         │
│                                                                           │
│  sendGroupForwardMessage(wsClient, groupId, forwardNodes)                 │
│    └── OneBot: send_group_forward_msg { group_id, messages }              │
│         ├── 每个 ForwardNode { uin, name, content }                       │
│         ├── uin: 伪造的用户 QQ 号（不在目标群的用户 → name 可生效）          │
│         ├── name: 伪装的昵称                                               │
│         └── → QQ 合并转发卡片                                              │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 失败处理机制

### Tool Call 循环 (Phase 1)

| 策略 | 说明 |
|------|------|
| 底层重试 | LLMClient 内部已有重试：5xx/网络 → 最多 5 次，4xx → 不重试抛错 |
| 失败处理 | ConversationLoop.run() 异常被 try-catch 捕获，**不阻断流程** |
| 失败记录 | 错误信息作为 `[系统提示]` 推入 messages 数组，供后续伪造步骤作为上下文 |
| 示例 | `[系统提示: 任务执行过程中出现错误: timeout。请根据已获取的信息尽可能生成聊天记录。]` |

### 聊天记录伪造 (Phase 2)

| 策略 | 说明 |
|------|------|
| 重试次数 | 最多 **3 次** |
| 退避策略 | 指数退避：1s → 2s → 4s（复用 `src/common/retry.ts`） |
| 日志记录 | 每次重试失败写入 LLM 日志 (`logs/llm-YYYY-MM-DD.log`)，含 `finishReason: "error"` |
| 最终失败 | 3 次全部失败 → 返回 `{ forwardNodes: [], error: "..." }` → P2 收到后不发送消息，记录错误日志 |
| 解析失败 | forgery 成功但解析不到有效 ForwardNode → 同样返回 error，不发送 |

### 错误传播

```
Phase 1 异常 → 记录到 messages 上下文 → 继续 Phase 2
Phase 2 异常 → retry(3次, 指数退避) → 全失败 → 返回 error 给 P2
Phase 3 异常 → 返回 error 给 P2
P2 收到 error → taskQueue.transition(id, "failed") → 不发送消息
```

---

## 模块归属

### 新建模块

| 模块 | 路径 | 职责 |
|------|------|------|
| MuriAgentLoop | `src/llmcore/muri-agent/loop.ts` | 封装 ConversationLoop + 聊天记录伪造 + ForwardNode 解析 |
| MuriAgentLoop Types | `src/llmcore/muri-agent/types.ts` | MuriAgentResult, MuriAgentConfig |
| MuriAgentExecutor | `src/convmgr/muri-agent/executor.ts` | 上下文构造 → IPC 调用 P3 → 合并转发发送 |

### 修改模块

| 模块 | 路径 | 改动 |
|------|------|------|
| IPC Types | `src/common/types/ipc.ts` | 新增 MuriAgentPayload, MuriAgentResponsePayload, ForwardNode.user_id |
| Config | `src/common/config.ts` | 新增 muriAgent 配置 (maxTurns, forgeryAlias) |
| Silent Text Extractor | `src/convmgr/silent-text-extractor.ts` | 实际提取 muri_agent 标记，传入 userId/messageId |
| Silent Tool Executor | `src/convmgr/silent-tools.ts` | 集成 MuriAgentExecutor，direct/queued 两条路径 |
| P2 IPC Server | `src/convmgr/ipc-server.ts` | handleTrigger 中传递 triggerUserId/triggerMsgId |
| P2 Index | `src/convmgr/index.ts` | 创建 MuriAgentExecutor + 注入 |
| P3 IPC Server | `src/llmcore/ipc-server.ts` | 新增 muri_agent handler |
| P3 Index | `src/llmcore/index.ts` | 创建 QQ fun ToolRegistry + MuriAgentLoop |

### 复用模块（不修改）

| 模块 | 路径 | 复用于 |
|------|------|--------|
| ConversationLoop | `src/llmcore/conversation-loop.ts` | MuriAgentLoop Phase 1 (tool call 循环) |
| LLMRelay | `src/llmcore/llm/relay.ts` | MuriAgentLoop Phase 1 + Phase 2 |
| LLMClient | `src/llmcore/llm/client.ts` | LLMRelay 内部调用 |
| ToolRegistry | `src/llmcore/tools/registry.ts` | QQ fun tools 注册（当前空） |
| TaskQueueManager | `src/convmgr/task-queue-manager.ts` | 串行 FIFO 调度 |
| TaskQueueLogger | `src/convmgr/task-queue-logger.ts` | 入队/出队日志 |
| IpcClient | `src/common/ipc/client.ts` | P2→P3, P2→P1 通信 |
| IpcServer | `src/common/ipc/server.ts` | P3 muri_agent handler |
| MessageRepository | `src/common/db/message-repository.ts` | 查询触发消息文本 |
| sendGroupForwardMessage | `src/receiver/send-api.ts` | 合并转发发送 |
| Logger | `src/common/logger.ts` | 全局日志 |

---

## 关键函数签名

### extractSilentCalls (修改后)

```typescript
// src/convmgr/silent-text-extractor.ts
export function extractSilentCalls(
  text: string,
  triggerUserId?: number,
  triggerMessageId?: number,
): ExtractedSilentCalls

// MuriAgentCall 扩展
export interface MuriAgentCall {
  task: string;
  userId?: number;      // 新增
  messageId?: number;   // 新增
}
```

### MuriAgentLoop

```typescript
// src/llmcore/muri-agent/loop.ts
export class MuriAgentLoop {
  constructor(
    relay: LLMRelay,
    qqFunRegistry: ToolRegistry,
    config: MuriAgentConfig,
  )
  async run(userContext: string): Promise<MuriAgentResult>
  private parseForwardNodes(text: string): ForwardNode[]
}
```

### MuriAgentExecutor

```typescript
// src/convmgr/muri-agent/executor.ts
export class MuriAgentExecutor {
  constructor(
    p3Client: IpcClient,
    p1Client: IpcClient,
    repo: MessageRepository,
    taskQueue: TaskQueueManager | null,
  )
  async execute(call: MuriAgentCall, groupId: number): Promise<void>
}
```

### SilentToolExecutor (修改后)

```typescript
// src/convmgr/silent-tools.ts
export interface SilentToolExecutorOptions {
  taskQueue?: TaskQueueManager;
  queuedTools?: Set<string>;
  muriAgentExecutor?: MuriAgentExecutor;  // 新增
  repo?: MessageRepository;                // 新增
}

// 新增私有方法
private executeMuriAgentQueued(call: MuriAgentCall, groupId: number): void
private executeMuriAgentDirect(call: MuriAgentCall, groupId: number): void
```

---

## 身份伪造机制

基于合并转发分析结论，muri_agent 使用深度身份伪装：

| 策略 | 说明 |
|------|------|
| UID 选择 | 使用不在目标群的用户 UID，`name` 字段完全可控 |
| 昵称伪造 | `ForwardNode.name` 设为伪装角色名 |
| 头像 | 跟随 UID 的真实头像（可预先准备一组"角色 QQ 号"） |
| 内容拆分 | 不按 50 字阈值，按伪造 preset 返回的 `[user_id:xxx|name:xxx]` 结构拆分 |

**注意**：不要使用群内成员 UID，否则 `name` 会被 QQ 客户端强制覆盖为真实群昵称。

---

## 配置 (.env)

```env
# --- Muri Agent ---
# muri_agent 最大工具调用轮次
MURI_AGENT_MAX_TURNS=4
# 聊天记录伪造步骤使用的 LLM alias
MURI_AGENT_FORGERY_ALIAS=LLM
```

**任务队列配置**（已有，在 `.env` 中启用即可）:
```env
# 启用 muri_agent 走任务队列（串行 FIFO）
SILENT_TOOL_QUEUE=muri_agent
# muri_agent 为串行工具
TASK_QUEUE_SERIAL=muri_agent
```

---

## 待实现（后续）

| 功能 | 说明 |
|------|------|
| QQ Fun Tools | 戳一戳、拉黑等 QQ 平台操作工具，注册到 P3 的 qqFunRegistry |
| muri_agent Preset | YAML 格式的 system prompt，替换硬编码占位 |
| 聊天记录伪造 Preset | YAML 格式的 forgery prompt，定义输出结构和角色 |
| 角色 UID 映射 | 预设一组不在目标群的 QQ 号 → 角色名映射表 |
