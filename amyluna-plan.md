# SnowLuma Adapter v2 重构实施计划（amyluna 版）

## Context

在 `/home/USER/amyluna` 全新实现三进程架构，不动 `/home/USER/snowluma_adapter` 原有代码。

**架构决策**:
- 单 package，三个入口文件，按模块分目录
- 新数据库 `amyluna`（MySQL），三张表全新创建
- `user_id` 保持 `BIGINT`
- IPC: TCP JSON 行协议（`\n` 分隔），支持 request-response

**核心数据流**:
```
P2 → P3: { context, preset, group_id, message_id }
P3 → P2: { group_id, message_id, content, silent_tool_calls? }
```

**工具分工**:
| 类型 | 执行方 | 示例 |
|------|--------|------|
| 非静默工具 (requiresFollowUp: true) | P3 内部循环 | `web_search`, `get_time`, MCP tools |
| 静默工具 (block 或 requiresFollowUp: false) | P3 识别，P2 执行 | `get_meme`, `update_affinity` |

> **测试阶段约束**: 白名单群 `WHITELIST_GROUP_IDS` 和错误发送群 `ERROR_ALERT_GROUP_ID` 均只有 `<GROUP_ID>`。

---

## Phase 1: 项目初始化 + 数据库

### 1.1 创建项目骨架
在 `/home/USER/amyluna` 初始化:
- `package.json`（依赖: `dotenv`, `mysql2`, `ws`; dev: `tsx`, `typescript`, `@types/node`, `@types/ws`）
- `tsconfig.json`（target ES2022, module CommonJS, strict）
- `.env` / `.env.example`
- 目录: `src/common/`, `src/receiver/`, `src/convmgr/`, `src/llmcore/`, `preset/`, `logs/`

### 1.2 创建数据库 `amyluna`
```sql
CREATE DATABASE IF NOT EXISTS amyluna
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

### 1.3 三张表 DDL（全新创建，非迁移）

**`chat_messages`**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | PK |
| `message_id` | `INT` | QQ 消息 ID，UNIQUE |
| `group_id` | `BIGINT` | 群号 |
| `sender_name` | `VARCHAR(255)` | 群名片 |
| `user_id` | `BIGINT` | 发送者 QQ |
| `is_private` | `TINYINT(1)` | 0=群聊, 1=私聊 |
| `role` | `ENUM('user','assistant','system','tool')` | |
| `content` | `TEXT` | 消息内容 |
| `tool_calls` | `JSON` | LLM tool_calls |
| `image_urls` | `TEXT` | 图片 URL 列表 |
| `video_urls` | `TEXT` | 视频 URL 列表 |
| `voice_urls` | `TEXT` | 语音 URL 列表 |
| `other_media` | `TEXT` | 其他媒体 |
| `merged_forward` | `TEXT` | 合并转发解析文本 |
| `media_parsed` | `INT DEFAULT 0` | 位掩码 |
| `quoted_message_id` | `VARCHAR(64)` | 被引用消息 ID |
| `created_at` | `DATETIME(3)` | 毫秒精度 |

索引: `UNIQUE uq_message_id`, `INDEX idx_group_time (group_id, created_at DESC)`, `INDEX idx_user_time (user_id, created_at DESC)`, `INDEX idx_quoted_msg (quoted_message_id)`

**`token_usage`**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | PK |
| `trigger_message_id` | `BIGINT` | |
| `reply_message_id` | `BIGINT` | |
| `group_id` | `BIGINT UNSIGNED` | |
| `model` | `VARCHAR(128)` | |
| `provider` | `VARCHAR(64)` | |
| `base_url` | `VARCHAR(512)` | |
| `prompt_tokens` | `INT UNSIGNED` | |
| `completion_tokens` | `INT UNSIGNED` | |
| `total_tokens` | `INT UNSIGNED` | |
| `cached_tokens` | `INT UNSIGNED` | |
| `reasoning_tokens` | `INT UNSIGNED` | |
| `cache_write_tokens` | `INT UNSIGNED` | |
| `cache_miss_tokens` | `INT UNSIGNED` | |
| `success` | `TINYINT(1)` | |
| `error_message` | `TEXT` | |
| `created_at` | `DATETIME` | |

索引: `INDEX idx_group_id`, `INDEX idx_created_at`

**`user_affinity`**:
| 字段 | 类型 | 说明 |
|------|------|------|
| `user_id` | `BIGINT` | PK |
| `long_term_affinity` | `INT DEFAULT 5` | |
| `short_term_changes` | `VARCHAR(255) DEFAULT ''` | |

索引: `PRIMARY KEY (user_id)`

### 1.4 创建共享模块（`src/common/`）
从 v1 提取纯函数和类型（不复制有副作用的逻辑，重写适配新架构）:

- `src/common/db/pool.ts` — MySQL 连接池，连 `amyluna` 库
- `src/common/db/message-repository.ts` — 完整 CRUD（含新 7 列 + `media_parsed` 位掩码）
- `src/common/db/token-repository.ts` — token 用量记录（P3 使用）
- `src/common/db/affinity-repository.ts` — 好感度持久化（P2 使用）
- `src/common/types/onebot.ts` — `GroupMessageEvent`, `MessageSegment`, `Sender` 等
- `src/common/types/llm.ts` — `ChatMessage`, `ToolCall`, `ToolDefinition`, `LLMResponse` 等
- `src/common/types/ipc.ts` — IPC 消息枚举和类型
- `src/common/logger.ts` — 支持进程标签的日志（`[P1]`, `[P2]`, `[P3]`）
- `src/common/text.ts` — 文本提取、CQ 码解析、`splitReply`、`buildReplySegments`
- `src/common/json.ts` — `safeJsonParse`
- `src/common/retry.ts` — 通用重试
- `src/common/config.ts` — 统一配置加载（各进程按需取切片）

### 1.5 实现 IPC 框架（`src/common/ipc/`）
- `types.ts`:
  ```typescript
  // IPC 消息类型枚举
  type IpcType = 'trigger' | 'chat' | 'chat_response' | 'send_message'
               | 'error_alert' | 'vision' | 'vision_result' | 'ping' | 'pong';
  // 消息格式
  interface IpcMessage { type: string; payload: any; request_id?: string; }
  // P2 → P3 chat 请求
  interface ChatRequest { context: string; preset: string; group_id: number; message_id: number; }
  // P3 → P2 chat 响应
  interface ChatResponse { group_id: number; message_id: number; content: string; silent_tool_calls?: SilentToolCall[]; }
  // 静默工具调用（P2 执行）
  interface SilentToolCall { name: string; arguments: Record<string, any>; }
  ```
- `server.ts` — `IpcServer`: TCP server，JSON 行协议，`request_id` 匹配
- `client.ts` — `IpcClient`: `send(type, payload)` + `request(type, payload): Promise<any>`

### 1.6 实现 Watchdog（`src/common/watchdog.ts`）
- 每进程每 5s ping 其他两进程
- 连续 3 次失败写 `logs/watchdog.log`
- 启动 10s 预热期不检测

---

## Phase 2: P3 — LLM Core (:3103)

**职责**: 加载预设 → 接收 P2 上下文 → 组装完整请求 → LLM 调用 + 非静默工具循环 → 返回结果

### 2.1 Preset Loader (`src/llmcore/preset-loader.ts`)
- 启动时扫描 `preset/` 目录，加载所有 `.yaml` 文件
- 解析 YAML front-matter（`name`, `trigger_keywords`）和 body（system prompt）
- 存入 `Map<name, PresetConfig>`:
  ```typescript
  interface PresetConfig {
    name: string;
    systemPrompt: string;          // front-matter 之后的全部内容
    triggerKeywords: string[];
  }
  ```
- 系统提示词组装在 P3 内部完成：`systemPrompt = preset.systemPrompt + AFFINITY_GUIDELINES + REPLY_FORMAT_CONSTRAINT`
- `getPreset(name)`: 按名称获取预设，不存在则抛异常

### 2.2 LLM 模块（`src/llmcore/llm/`）
从 v1 迁移并适配:
- `client.ts` — `LLMClient`: HTTP OpenAI 兼容调用，超时/重试
- `relay.ts` — `LLMRelay`: 别名 → provider 路由
- `provider.ts` — `loadLLMProviders(env)`: 解析 `LLM_PROVIDERS_JSON`
- `response-logger.ts` → `llm-logger.ts`: 写入 `logs/llm-YYYY-MM-DD.log`

### 2.3 Tool 系统（`src/llmcore/tools/`）

**仅注册非静默工具**（P3 内部执行）:
- `registry.ts` — `ToolRegistry`: 注册/查找/执行
- `types.ts` — `ToolMeta`, `ToolResult`
- `builtin/web-search.ts` — `web_search`（`requiresFollowUp: true`）
- `builtin/get-time.ts` — `get_time`（`requiresFollowUp: true`）
- `mcp/` — MCP 客户端（`requiresFollowUp: true` 的工具）

**不注册静默工具**（`get_meme`, `update_affinity`），这些由 P2 处理。

### 2.4 Conversation Loop（`src/llmcore/conversation-loop.ts`）
从 v1 迁移并重构:

```typescript
// 输入: 组装好的 messages (system + user context)
// 输出: { content, silentToolCalls }
interface LoopResult {
  content: string;
  silentToolCalls: SilentToolCall[];
}
```

核心逻辑:
1. `relay.chatRaw(messages, tools)` — tools 仅为非静默工具
2. 记录 token 用量到 DB
3. `finishReason === "stop"` → 返回 `content`，检查是否有需要 P2 执行的静默工具标记
4. 有 tool_calls:
   - **非静默工具**: P3 内部执行，结果以 `role:"tool"` 推回 messages，继续下一轮
   - **静默工具**（不在 P3 ToolRegistry 中的 tool_call）: 收集到 `silentToolCalls[]`，作为 `role:"tool"` 推回 messages（告知 LLM 工具已执行），继续循环直到 stop
5. 循环上限 `maxTurns`，超限强制无工具调用获取最终回复
6. 返回 `{ content, silentToolCalls }`

**关键**: P3 的 ToolRegistry 只注册非静默工具。LLM 返回的任何不在 registry 中的 tool_call 被视为静默工具 — P3 不执行，仅推一个占位 tool result（如 `"(由 P2 执行)"`）回 messages，同时收集到 `silentToolCalls[]`，然后继续 LLM 循环直到 stop。

### 2.5 Vision 接口（`src/llmcore/vision.ts`）
- 复用 v1 `describeImages()` 逻辑
- IPC: 接收 P1 `vision { image_urls }` → 返回 `vision_result { descriptions }`

### 2.6 TTS 接口（`src/llmcore/tts.ts`）
- 预留，函数体抛 `Not implemented`

### 2.7 P3 IPC Server（`src/llmcore/ipc-server.ts`）
- 接收 P2 `chat`: `{ context, preset, group_id, message_id }`
  1. `presetLoader.getPreset(preset)` 获取 system prompt
  2. 组装 messages: `[{ role: "system", content: systemPrompt }, { role: "user", content: context }]`
  3. `ConversationLoop.run(messages)`（非静默工具循环在 P3 内完成）
  4. 返回 P2: `chat_response { group_id, message_id, content, silent_tool_calls? }`
  5. 超时/异常 → P1: `error_alert { group_id, message }`（`ERROR_ALERT_GROUP_ID`）
- 接收 P1 `vision`: 异步处理，返回 `vision_result`

### 2.8 P3 IPC Client（`src/llmcore/ipc-client.ts`）
- → P2: 发送 `chat_response`
- → P1: 发送 `error_alert`

### 2.9 P3 入口（`src/llmcore/index.ts`）
```
加载 config → 加载 presets → 初始化 LLM Relay → 注册非静默工具 → 连接 MCP → 启动 IPC Server → 启动 Watchdog
```

---

## Phase 3: P1 — Receiver (:3101)

**职责**: WS 连接管理、消息入库、触发判断、消息发送、富媒体异步处理

### 3.1 WS 客户端（`src/receiver/ws-client.ts`）
从 v1 `SnowLumaClient` 迁移:
- WS 连接/心跳/指数退避重连
- `request<T>(action, params)` — 带 echo 匹配和 30s 超时
- `onGroupMessage` 回调 → 连接新流水线

### 3.2 发送 API（`src/receiver/send-api.ts`）
从 v1 `api.ts` 迁移:
- `sendGroupMessage`, `sendGroupForwardMessage`, `getForwardMsg`
- 通过 IPC Server 接收 P2 的 `send_message` 委托

### 3.3 Message Saver（`src/receiver/message-saver.ts`）
- 收到即存 DB（白名单群才入库）
- 富媒体提取（解析 `MessageSegment[]`）:
  - `image` → `image_urls` 列 + `media_parsed` bit0
  - `video` → `video_urls` 列 + `media_parsed` bit1
  - `record` → `voice_urls` 列 + `media_parsed` bit2
  - `forward` → 调 `get_forward_msg` 解析 → `merged_forward` 列 + `media_parsed` bit3
  - 其他 → `other_media` 列 + `media_parsed` bit4+
- 提取 `quoted_message_id`（从 reply 段）

### 3.4 Trigger 判断（`src/receiver/trigger.ts`）
从 v1 `ChatManager.isTriggered()` 迁移:
- 优先级: AT → 引用(reply) → 关键词 → PRD
- PRD `prdP` 维护在 P1 本地（每群一个 Map）
- 命中后 IPC → P2: `trigger { group_id, message_id }`

### 3.5 富媒体异步处理
- 图片入库后，异步 IPC → P3: `vision { image_urls }` → 结果回写 DB（替换 content 中的 `[image]`）
- 视频/语音仅占位

### 3.6 P1 IPC Server（`src/receiver/ipc-server.ts`）
- 接收 P2 `send_message { group_id, message, method? }` → 调用 send API，返回 `{ message_id }`
- 接收 P3 `error_alert { group_id, message }` → 直接发送到 `ERROR_ALERT_GROUP_ID`

### 3.7 P1 IPC Client（`src/receiver/ipc-client.ts`）
- → P2: `trigger { group_id, message_id }`
- → P3: `vision { image_urls }`

### 3.8 P1 入口（`src/receiver/index.ts`）
```
加载 config → 连接 DB → 初始化 repo → 创建 WS client → 启动 IPC Server → 启动 Watchdog → client.connect()
```

---

## Phase 4: P2 — Conversation Manager (:3102)

**职责**: 冷却管理、上下文构建与格式化、后处理、静默工具执行、好感度管理

### 4.1 冷却器（`src/convmgr/cooldown.ts`）
```typescript
interface CooldownState {
  groupId: number;
  lastTriggerMsgId: number | null;
  triggerTime: number;
  isCooling: boolean;
  msgCache: number[];      // 缓存 message_id
  timer: NodeJS.Timeout | null;
}
```
- CD 值从 `CHAT_COOLDOWN_MS` 读取
- `isCooling=false` → 立即处理，`isCooling=true`
- `isCooling=true` → push 到 `msgCache[]`
- timer 到期: 若 `msgCache` 非空 → 用最新一条发起对话；若空 → `isCooling=false`

### 4.2 上下文构建器（`src/convmgr/context-builder.ts`）

这是 P2 的核心模块。不再维护内存队列，每次从 DB 查询构建:

```typescript
interface BuildResult {
  context: string;       // 格式化后的纯文本上下文
  contextJson?: object;  // 可选的 JSON 结构化上下文
}
```

流程:
1. 从 DB 查最近 N 条（`contextLimit`）消息
2. 过滤: 排除 bot 自身消息作为 user 角色
3. 引用解析: 若消息有 `quoted_message_id`，查 DB 获取被引用消息
4. 好感度注入: 通过 `AffinityInjector` 为每个 user 消息注入 `affinity:N`
5. 格式化每条消息为 v1 格式:
   ```
   [MsgID:xxx] [↑触发标记] [sender_name](user_id) {group:xxx, affinity:N}: text
   ```
6. 组合成完整上下文字符串或 JSON
7. 发送给 P3: `chat { context, preset, group_id, message_id }`

### 4.3 后处理器（`src/convmgr/post-process.ts`）
从 v1 迁移:
- 动作描述拆解 `（...）`
- 情感标签匹配
- 纯文本字数统计 → `sendMethod: "normal" | "forward"`
- 静默工具调用提取: 从 P3 返回的 `silent_tool_calls[]` 中解析并执行

### 4.4 静默工具执行器（`src/convmgr/silent-tools.ts`）

P2 收到 P3 返回的 `silent_tool_calls` 后执行:

**`get_meme`**:
- 验证 tag（29 个合法值），返回 memesluna URL
- URL 附加到回复末尾（或替换占位符）

**`update_affinity`**:
- 调用 `AffinityCache.addDelta(userId, delta)`
- 不产生用户可见输出

执行结果:
- 静默工具不需要返回给 LLM（P3 已推占位 tool result）
- 仅处理副作用（meme URL、好感度更新）

### 4.5 好感度模块（`src/convmgr/affinity/`）
从 v1 完整迁移:
- `types.ts` — `ContextInjector`, `parseAffinity`, `effectiveAffinity`
- `repository.ts` — DB CRUD（`user_affinity` 表）
- `cache.ts` — 内存状态机（`+1/-1` 合并逻辑）
- `injector.ts` — 为上下文注入 `affinity:N`

### 4.6 P2 IPC Server（`src/convmgr/ipc-server.ts`）
- 接收 P1 `trigger { group_id, message_id }`:
  1. 冷却器判断
  2. 若需处理: context-builder 构建格式化上下文
  3. IPC → P3: `chat { context, preset, group_id, message_id }`
- 接收 P3 `chat_response { group_id, message_id, content, silent_tool_calls? }`:
  1. 如有 `silent_tool_calls`: 执行静默工具（meme URL、好感度更新）
  2. 后处理（post-process.ts）
  3. IPC → P1: `send_message { group_id, message, method }`
  4. 好感度落地 DB
  5. 清空 `msgCache`，重触发冷却

### 4.7 P2 IPC Client（`src/convmgr/ipc-client.ts`）
- → P1: `send_message`
- → P3: `chat { context, preset, group_id, message_id }`

### 4.8 P2 入口（`src/convmgr/index.ts`）
```
加载 config → 连接 DB → 初始化 repos → 初始化 AffinityCache → 启动 IPC Server → 启动 Watchdog
```

---

## Phase 5: 集成与收尾

### 5.1 启动配置
```env
# 进程端口
P1_PORT=3101
P2_PORT=3102
P3_PORT=3103

# Watchdog
WATCHDOG_INTERVAL_MS=5000
WATCHDOG_MAX_FAILURES=3

# 测试阶段: 白名单和报错群均只有 <GROUP_ID>
WHITELIST_GROUP_IDS=<GROUP_ID>
ERROR_ALERT_GROUP_ID=<GROUP_ID>
```

### 5.2 package.json scripts
```json
{
  "scripts": {
    "dev:p1": "tsx watch src/receiver/index.ts",
    "dev:p2": "tsx watch src/convmgr/index.ts",
    "dev:p3": "tsx watch src/llmcore/index.ts",
    "build": "tsc -p tsconfig.json",
    "start:p1": "node dist/receiver/index.js",
    "start:p2": "node dist/convmgr/index.js",
    "start:p3": "node dist/llmcore/index.js",
    "typecheck": "tsc --noEmit"
  }
}
```

### 5.3 启动顺序
P3 → P2 → P1（P1 最后启动，依赖 WS 连接）

### 5.4 最终目录结构
```
amyluna/
├── src/
│   ├── common/
│   │   ├── db/
│   │   │   ├── pool.ts
│   │   │   ├── message-repository.ts
│   │   │   ├── token-repository.ts
│   │   │   └── affinity-repository.ts
│   │   ├── ipc/
│   │   │   ├── server.ts
│   │   │   ├── client.ts
│   │   │   └── types.ts
│   │   ├── types/
│   │   │   ├── onebot.ts
│   │   │   └── llm.ts
│   │   ├── config.ts
│   │   ├── logger.ts
│   │   ├── text.ts
│   │   ├── json.ts
│   │   ├── retry.ts
│   │   └── watchdog.ts
│   │
│   ├── receiver/                  # P1 :3101
│   │   ├── index.ts
│   │   ├── ws-client.ts
│   │   ├── send-api.ts
│   │   ├── message-saver.ts
│   │   ├── trigger.ts
│   │   ├── ipc-server.ts
│   │   └── ipc-client.ts
│   │
│   ├── convmgr/                   # P2 :3102
│   │   ├── index.ts
│   │   ├── cooldown.ts
│   │   ├── context-builder.ts
│   │   ├── post-process.ts
│   │   ├── silent-tools.ts
│   │   ├── affinity/
│   │   │   ├── cache.ts
│   │   │   ├── injector.ts
│   │   │   ├── repository.ts
│   │   │   └── types.ts
│   │   ├── ipc-server.ts
│   │   └── ipc-client.ts
│   │
│   └── llmcore/                   # P3 :3103
│       ├── index.ts
│       ├── preset-loader.ts
│       ├── conversation-loop.ts
│       ├── vision.ts
│       ├── tts.ts
│       ├── llm-logger.ts
│       ├── llm/
│       │   ├── relay.ts
│       │   ├── client.ts
│       │   ├── provider.ts
│       │   └── response-logger.ts
│       ├── tools/
│       │   ├── registry.ts
│       │   ├── types.ts
│       │   ├── builtin/
│       │   │   ├── index.ts
│       │   │   ├── web-search.ts
│       │   │   └── get-time.ts
│       │   └── mcp/
│       │       └── client.ts
│       ├── ipc-server.ts
│       └── ipc-client.ts
│
├── preset/
│   └── holo.yaml
├── logs/
├── .env
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Phase 6: 验证方案

> **测试期间所有消息仅在群 `<GROUP_ID>` 内收发，不涉及其他群。**

### 6.1 启动测试
1. 启动 P3 → P2 → P1
2. 验证 watchdog `ping/pong` 正常
3. kill P2，验证 P1/P3 互检失败 3 次后写 `watchdog.log`

### 6.2 完整消息链路
在群 `<GROUP_ID>` 发消息 → P1 入库 + 触发 → P2 冷却 + 构建格式化上下文 → P3 组装请求 + LLM 调用 + 非静默工具循环 → P2 后处理 + 静默工具执行 → P1 发送到群 `<GROUP_ID>`

### 6.3 边界测试
- 非白名单群: 不存 DB，不触发（测试阶段仅 `<GROUP_ID>` 为白名单）
- 冷却期多条消息: 进 `msgCache[]`，冷却结束用最新一条
- LLM 超时: P3 → P1 `error_alert` 发送到 `<GROUP_ID>`，不经过 P2
- P1 WS 断连重连: 自动重连
- 图片消息: 异步 vision 回写 DB
- 静默工具 `get_meme`: P3 返回 `silent_tool_calls` → P2 执行，URL 附到回复末尾
- 静默工具 `update_affinity`: P3 返回 `silent_tool_calls` → P2 执行，好感度落地 DB
