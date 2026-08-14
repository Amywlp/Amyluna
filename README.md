# Amyluna-v2.2

SnowLuma Adapter v2 — 三进程 QQ 机器人，基于 OneBot v11 协议的 LLM 角色扮演框架。集成 LLM 对话、工具调用、好感度系统、图片理解、MCP 协议、定时提醒、任务队列和 MySQL 持久化。

三进程通过 TCP JSON-line IPC 通信，各自独立部署和重启。

---

## 架构总览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              QQ 群消息                                    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ↓ WebSocket (心跳 + 自动重连)
┌──────────────────────────────────────────────────────────────────────────┐
│  P1 — Receiver (:3101)                                                    │
│                                                                           │
│  WsClient (OneBot WS)                                                     │
│    ├── 消息去重                                                            │
│    ├── saveMessage() → MySQL                                              │
│    ├── 图片提取 → vision IPC → P3                                         │
│    ├── isTriggered() — 四级优先级: AT > 引用回复 > 关键词 > PRD 随机       │
│    └── RateLimiter — 每用户每窗口 N 次触发限制（随机插嘴豁免）              │
│         ↓ trigger IPC                                                     │
├──────────────────────────────────────────────────────────────────────────┤
│  P2 — Conversation Manager (:3102)                                        │
│                                                                           │
│  CooldownManager (每群独立冷却)                                            │
│    └── handleTrigger()                                                    │
│         ├── ContextBuilder → 上下文构建 + 好感度注入                        │
│         ├── chat IPC (request-response) → P3                              │
│         ├── extractSilentCalls() → 文本标记提取                            │
│         ├── SilentToolExecutor → 静默工具分流执行                           │
│         │     ├── getmeme → 直接执行（永不走队列）                          │
│         │     ├── timer/affinity → 按配置走 TaskQueue 或直接执行            │
│         │     └── tts/muri_agent/text2image → 串行 FIFO 执行               │
│         ├── TaskQueueManager → 任务生命周期管理（入队/调度/完成/资源释放）   │
│         ├── PostProcessor → 发送方式判断                                   │
│         ├── TimerManager → 定时提醒（后台 setTimeout）                     │
│         └── send_message IPC → P1                                         │
├──────────────────────────────────────────────────────────────────────────┤
│  P3 — LLM Core (:3103)                                                    │
│                                                                           │
│  ConversationLoop (主 agent 工具调用循环)                                   │
│    ├── System prompt 拼接 (preset + affinity + reply format)              │
│    ├── LLMRelay → alias 路由 provider                                     │
│    ├── ToolRegistry → 注册工具执行 (get_time / web_search / temp_mute / context_review / MCP) │
│    ├── 静默工具识别 → silent_tool_calls[]                                 │
│    ├── describeImages() → vision 模型 → DB 回填                           │
│    └── intermediate_reply → 中间回复即时推送                               │
│                                                                           │
│  MuriAgentLoop (子 agent 独立 LLM 循环，串行静默工具)                       │
│    ├── Phase 1: ConversationLoop 复用 → QQ fun tools 调用                 │
│    ├── Phase 2: 聊天记录伪造 (muri.yaml preset → 母女对话)                 │
│    └── Phase 3: 解析 → ForwardNode[] → 合并转发身份伪造                   │
└──────────────────────────────────────────────────────────────────────────┘
                               ↓
                    ┌──────────────────────┐
                    │ MySQL (amyluna)       │
                    │ - chat_messages       │
                    │ - user_affinity        │
                    │ - token_usage          │
                    └──────────────────────┘
```

---

## 进程架构

| 进程 | 端口 | 入口 | 职责 |
|------|------|------|------|
| **P1** Receiver | `:3101` | `src/receiver/index.ts` | OneBot WS 连接、消息入库、触发判断、消息发送 |
| **P2** ConvMgr | `:3102` | `src/convmgr/index.ts` | 冷却管理、上下文构建、静默工具执行、后处理 |
| **P3** LLM Core | `:3103` | `src/llmcore/index.ts` | LLM 调用、工具循环、vision 图片描述、MCP 连接 |

**IPC 协议**：TCP JSON 行协议（`\n` 分隔），支持 `request_id` 匹配的 request-response 模式。

| 消息类型 | 方向 | 模式 | 说明 |
|----------|------|------|------|
| `trigger` | P1 → P2 | fire-and-forget | 消息触发（含 group_id / message_id） |
| `chat` | P2 → P3 | request-response | 主 agent 对话请求 |
| `intermediate_reply` | P3 → P2 | fire-and-forget | 工具调用中间文本即时推送 |
| `chat_response` | P3 → P2 | response | 附在 chat 响应中，由 P2 读取 |
| `send_message` | P2 → P1 | request-response | 委托 P1 发送消息（支持 forward / normal） |
| `vision` | P1 → P3 | fire-and-forget (async ack) | 图片描述请求 |
| `muri_agent` | P2 → P3 | request-response | 子代理任务请求 |
| `qq_action` | P3 → P1 | request-response | QQ 互动操作（poke / like / reaction） |
| `temp_mute` | P3 → P1 | request-response | 临时禁言请求（mute_time × severe_level） |
| `ping` | 各进程间 | request-response | Watchdog 心跳 |

---

## 项目结构

```
.env                        配置（token、端点、阈值）
.env.example                配置模板
package.json                单 package，三个入口
tsconfig.json
ecosystem.config.js         PM2 三进程部署配置
start.sh                    一键启动脚本
合并转发机制.md              合并转发消息解析/发送机制说明
amyluna-plan.md             架构规划文档
muri-agent-plan.md          缪里子 agent 设计文档
tts-plan.md                 TTS 语音合成方案文档
data/
  tts/                      TTS 音频临时输出（运行时生成）
dist/                       编译产物（tsc → dist/）
logs/                       运行时日志（按日滚动 + LLM 响应日志）
preset/
  holo.yaml                 赫萝角色 prompt（主 agent 系统预设）
  muri.yaml                 缪里子 agent 母女对话生成预设
  text2image.yaml           文生图提示词生成系统预设
src/
  common/                   三进程共享
    config.ts                读取 .env，生成类型化 AppConfig
    logger.ts                结构化 JSON 日志（按日滚动，进程标签）
    retry.ts                 通用重试工具
    text.ts                  CQ 码提取/清洗、图片 URL 提取
    json.ts                  JSON 安全解析
    watchdog.ts              三进程互相 ping 监控
    types/
      index.ts               barrel export
      ipc.ts                 IPC 消息类型定义 + IpcPayloadMap
      onebot.ts              OneBot v11 事件/消息段类型
      llm.ts                 LLM 类型（跨进程共享）
    ipc/
      server.ts              TCP IPC Server — JSON 行协议，handler 注册
      client.ts              TCP IPC Client — send (fire-and-forget) + request (等待响应)
      test-ipc.ts            IPC 集成测试
    db/
      pool.ts                mysql2 连接池工厂 + ensureTables()
      message-repository.ts  insertOrReplace / findRecentByGroup / findRecentByGroupAndUser / findByMessageId / updateContent
      affinity-repository.ts 好感度 upsert / getAll
      token-repository.ts    token 用量记录
      init-db.ts / test-db.ts
  receiver/                 P1 — 消息接收与发送
    index.ts                 入口 — 组装 WS client、IPC、trigger、rate limiter、temp mute list
    ws-client.ts             OneBot WebSocket 连接、心跳、指数退避重连
    message-saver.ts         消息解析入库（提取文本/图片/转发）
    trigger.ts               四级触发判断: AT > 引用回复 > 关键词 > PRD 随机
    rate-limiter.ts          用户请求频率限制 — 每窗口 N 次触发，定时重置
    send-api.ts              OneBot API 封装 (send_group_msg / send_group_forward_msg)
    temp-mute-list.ts        内存静音列表 — 惰性清理过期条目 + 禁言判定
    ipc-server.ts            P1 IPC Server — 处理 send_message / error_alert / temp_mute / temp_mute
    ipc-client.ts            P1 IPC Client 工厂
    test-p1.ts               P1 集成测试
  convmgr/                  P2 — 会话管理与协调
    index.ts                 入口 — 组装所有模块并启动
    cooldown.ts              CooldownManager — 每群独立冷却 + 消息缓存批处理
    context-builder.ts       ContextBuilder — DB 查询 → 名称对齐 → 引用解析 → 格式化
    silent-text-extractor.ts 从 LLM 回复中提取 getmeme() / affinity() / timer() / tts() / muri_agent() 标记
    silent-tools.ts          SilentToolExecutor — 静默工具分流执行（直接/任务队列）
    task-queue-types.ts      任务队列类型定义 (SilentToolType / QueuedTask / ToolDefinition / TaskQueueStats)，支持 text2image
    task-queue-logger.ts     任务队列日志 — 记录入队/出队事件，不记录工具内部细节
    task-queue-manager.ts    TaskQueueManager — 并行/串行调度、FIFO 槽位锁、生命周期管理
    timer-manager.ts         TimerManager — setTimeout 定时提醒，到期 @用户
    post-process.ts          PostProcessor — 动作提取 / 情感标签匹配 / 发送方式选择
    ipc-server.ts            P2 IPC Server — 处理 trigger / chat_response / intermediate_reply
    ipc-client.ts            P2 IPC Client 工厂
    muri-agent/
      executor.ts            MuriAgentExecutor — P3 IPC 调用 + 合并转发发送
    tts/
      types.ts               TTS 类型定义 (TtsLang, VoiceConfig, TtsResult, ...)
      voices.ts              VoiceRegistry — {voice}_{lang}_infer_config.json 配置加载
      so-vits-client.ts      SoVitsClient — POST /tts HTTP 客户端 (AbortController + 重试)
      executor.ts            TtsExecutor — 合成+发送 (sequential/forward-audio/forward-video)
    text2image/
      types.ts               Text2Image 类型定义 (Text2ImageResult, Text2ImageExecutorOptions)
      executor.ts            Text2ImageExecutor — LLM提示词生成→图片API→下载→合并转发发送
    affinity/
      types.ts               好感度类型 + parseAffinity / formatAffinity / clampAffinity + 印象/冒犯关键词
      cache.ts               内存缓存 + 状态机（抵消 → 合并 → DB 写入）+ 印象管理
      injector.ts            AffinityInjector — 注入 affinity:N 到上下文
    test-p2.ts               P2 集成测试
  llmcore/                  P3 — LLM 调用与工具执行
    index.ts                 入口 — 组装 relay / registry / MCP / vision / IPC
    preset-loader.ts         加载 YAML preset，解析 front-matter
    conversation-loop.ts     ConversationLoop — 工具调用 while 循环（最多 maxTurns 轮）
    vision.ts                describeImages() — 多模态 vision 模型图片描述
    tts.ts                   TTS 语音合成接口（预留）
    ipc-server.ts            P3 IPC Server — 处理 chat / vision / muri_agent / temp_mute / ping
    ipc-client.ts            P3 IPC Client 工厂
    muri-agent/
      types.ts               MuriAgentResult / MuriAgentConfig / MuriAgentContext
      loop.ts                MuriAgentLoop — Phase 1 工具循环 + Phase 2 对话伪造 + Phase 3 解析
    llm/
      types.ts               ChatMessage / ChatResponse / ToolCall / LLMResponse
      client.ts              fetch 封装，5xx/网络重试，4xx 不重试
      relay.ts               LLMRelay — alias → provider 路由
      llm-logger.ts          LLM 完整响应写入 logs/llm-YYYY-MM-DD.log
    tools/
      types.ts               ToolMeta / ToolResult
      registry.ts            ToolRegistry — register / execute (超时保护 + 截断)
      builtin/
        index.ts             主 agent 工具注册入口
        get-time.ts          获取当前时间（支持 IANA 时区）
        web-search.ts        Tavily 网络搜索
        context-review.ts    聊天记录回顾 — 检索用户最近消息（好感度 > 8 可用）
        temp-mute.ts         临时禁言 — mute_time × severe_level，印象联动升级
        qq-fun.ts            QQ 互动工具（group_poke / send_like / set_group_reaction，仅 muri_agent 使用）
      mcp/
        client.ts            MCP 客户端 — stdio + SSE 传输、JSON-RPC、connectMcpTools()
    test-p3.ts               P3 集成测试
```

---

## 完整消息处理时序

```
1. QQ 群用户发送消息
       ↓
2. SnowLuma WS Server 推送 JSON 事件
       ↓
3. P1 WsClient.handleMessage()
   ├── 白名单检查
   ├── 去重 (recentMessageIds 滑动窗口)
   ├── temp_mute 检查（用户被禁言时跳过触发判断）
   ├── 跳过 bot 自身消息的触发判断（记录 bot 消息 ID 供 reply 检测）
   │
   ├── 1. saveMessage() → MySQL 持久化（含 bot 自身消息）
   │      ├── extractTextContent() → 纯文本 / [image] 占位符
   │      ├── extractImageUrls() → 图片 URL 列表
   │      └── insertOrReplace() → DB
   │
   ├── 2. 图片消息 → p3Client.send("vision", {image_urls, group_id, message_id})
   │      └── P3 describeImages() → vision 模型 → updateContent() 回填 DB
   │
   ├── 3. isTriggered() — 四级优先级：
   │   ├── 优先级 1: AT (@bot)
   │   ├── 优先级 2: 引用回复 (reply to bot 消息)
   │   ├── 优先级 3: 关键词前缀 (如 "赫萝~")
   │   └── 优先级 4: PRD 随机 (概率累积，C 值由 PRD_C 配置)
   │
   ├── 4. 速率限制检查（随机插嘴 reason="prd" 跳过）
   │   └── RateLimiter.checkAndDecrement(userId) → 剩余次数 > 0 则放行并扣减
   │       → 次数耗尽则跳过本次触发，等待窗口重置
   │
   └── 5. 触发 → p2Client.send("trigger", {group_id, message_id, reason})
           ↓
4. P2 IPC Server → CooldownManager.onTrigger()
   ├── 不在冷却 → handleTrigger() 立即处理 → 启动冷却计时器
   └── 冷却中 → msgCache 缓存 → CD 到期 flushBatch() 取最新一条
       ↓
5. handleTrigger() — 回复流水线
   ├── 5a. 查 trigger 消息的 user_id（timer 需要）
   │
   ├── 5b. ContextBuilder.build(triggerMsgId)
   │      ├── findRecentByGroup() → DB 查询最近 N 条
   │      ├── normalizeNames() → 同用户统一为最新群名片
   │      ├── resolveQuotes() → 引用消息嵌入 (↳ MsgID「原文」)
   │      ├── AffinityInjector.inject() → 注入 affinity:N
   │      ├── 格式化为上下文字符串:
   │      │     [MsgID:xxx] [sender](user_id) {group:xxx, affinity:5}: text
   │      └── 底部追加 [触发消息] 段（触发消息单独拎出；随机插嘴显示 "(随机插嘴)"）
   │
   ├── 5c. p3Client.request("chat", {context, preset, group_id, message_id, user_id, time, affinity, trigger_user_impressions})
   │       ↓
   │  P3 IPC Server → ConversationLoop.run(messages)
   │    for turn in [0, maxTurns):
   │      relay.chatRaw(messages, tools)
   │      ├── LLMRelay: alias → provider 路由
   │      ├── LLMClient: POST {baseUrl}/chat/completions (重试: 5xx→重试, 4xx→抛错)
   │      ├── onTokenUsage → TokenRepository 写入
   │      ├── logLLMResponse → logs/llm-YYYY-MM-DD.log
   │      │
   │      switch finish_reason:
   │        "stop"     → reply = content, break
   │        "length"   → reply = content (截断警告), break
   │        tool_calls:
   │          ├── 注册工具 → ToolRegistry.execute() → 结果入 messages
   │          │     ├── get_time → 当前时间查询
   │          │     ├── web_search → Tavily 搜索
   │          │     ├── context_review → DB 检索用户最近消息（好感度 > 8 校验）
   │          │     ├── temp_mute → IPC→P1 静音列表（印象联动升级）
   │          │     └── MCP 工具 → MCP server 调用
   │          ├── 未注册工具 → 收集到 silent_tool_calls[]
   │          ├── requiresFollowUp: true → continue 下一轮
   │          ├── 中间回复: onIntermediateReply() → P2 → P1 (即时推送)
   │          └── requiresFollowUp: false → break
   │        other      → reply = content, break
   │
   │    [循环耗尽] reply 为空 → 无工具再调一次 chatRaw
   │
   │    返回 {content, silent_tool_calls[]}
   │
   ├── 5d. extractSilentCalls(content) → 提取文本标记
   │      ├── getmeme(标签) → memeTag
   │      ├── affinity(id, bool, "印象?") → affinityCalls[]（含可选印象）
   │      ├── timer(时间, "文本") → timerCall
   │      ├── tts("文本", "语言?", "翻译?") → ttsCall { text, lang?, translation? }
   │      ├── muri_agent("任务") → muriAgentCall (含 userId / messageId / task)
   │      └── text2image("主题") → text2imageCall { topic }
   │
   ├── 5e. silentTools.executeExtracted() → 静默工具分流执行
   │      ├── meme → 直接执行（拼接 memesluna URL，永不走队列）
   │      ├── affinity → 按 SILENT_TOOL_QUEUE 配置:
   │      │     排队 → TaskQueue.enqueue("affinity") → addDelta(onComplete) → dequeue
   │      │     直接 → AffinityCache.addDelta() → 印象存储 addImpression()
   │      ├── timer → 按 SILENT_TOOL_QUEUE 配置:
   │      │     排队 → TaskQueue.enqueue("timer") → TimerManager.set(onComplete) → dequeue
   │      │     直接 → TimerManager.set() → setTimeout
   │      ├── tts → 排队: enqueue("tts") → waitForRunning() → setModel(lang) → synthesize() → sendMessage(); 发送: sequential(默认, 音频+合并文本) | forward-audio(保留, QQ bug) | forward-video(占位)
   │      ├── muri_agent → 按 SILENT_TOOL_QUEUE 配置:
   │      │     排队 → TaskQueue.enqueue("muri_agent") → MuriAgentExecutor.execute() → dequeue
   │      │     直接 → MuriAgentExecutor.execute() (fire-and-forget)
   │      └── text2image → 按 SILENT_TOOL_QUEUE 配置:
   │            排队 → TaskQueue.enqueue("text2image") → waitForRunning() → LLM提示词→图片API→下载→合并转发发送
   │            直接 → Text2ImageExecutor.execute() (fire-and-forget)
   │            │
   │            └── MuriAgentExecutor.execute(call, groupId, taskId?)
   │                  ├── 1. repo.findByMessageId() → 获取触发消息文本
   │                  ├── 2. 构造结构化 MuriAgentPayload → P3 IPC
   │                  │       ↓
   │                  │  P3 muri_agent handler:
   │                  │    ├── Phase 1: ConversationLoop(relay, qqFunRegistry, maxTurns)
   │                  │    │      └── QQ fun tools 调用 (group_poke / send_like / set_group_reaction)
   │                  │    │           → qq_action IPC → P1 → OneBot action
   │                  │    ├── Phase 2: 聊天记录伪造 (muri.yaml preset + 3 次退避重试)
   │                  │    │      └── LLM 生成 --- 分隔的结构化母女对话
   │                  │    └── Phase 3: parseDialogueToNodes() → ForwardNode[]
   │                  │         └── 角色→uin 映射 (赫萝:<BOT_ID>, 缪里:<MURI_BOT_ID>)
   │                  │       ↓ reply({ forward_nodes, error? })
   │                  ├── 3. taskQueue.transition(taskId, "completed"|"failed")
   │                  └── 4. p1Client.request("send_message", {method:"forward", forward_nodes})
   │                         → P1 sendGroupForwardMessage() → QQ 合并转发卡片（身份伪造）
   │
   ├── 5f. PostProcessor(text) → 发送方式选择
   ├── 5g. p1Client.request("send_message", {message, method, meme_url, forward_nodes})
   │      method="forward" 时附带 forward_nodes: [{ uin: botId, content: 完整文本 }]
   │       ↓
   │  P1 IPC Server → forward_nodes 存在 → sendGroupForwardMessage()
   │                → 无 forward_nodes → downloadMemeToBase64 (若有) → sendGroupMessage()
   │
   ├── 5h. insertOrReplace() → DB 持久化 bot 回复 (role: "assistant")
   │
   └── 5i. cooldown.updateLastRepliedTime()
```

### 关键时间参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `SNOWLUMA_HEARTBEAT_INTERVAL_MS` | 30000 | WS 心跳间隔 |
| `SNOWLUMA_RECONNECT_BASE_DELAY_MS` | 1000 | 重连基础延迟（指数退避） |
| `SNOWLUMA_RECONNECT_MAX_DELAY_MS` | 30000 | 重连最大延迟 |
| `CHAT_COOLDOWN_MS` | 10000 | 触发冷却窗口 |
| `CHAT_REPLY_TIMEOUT_MS` | 60000 | chat IPC 请求超时 |
| `PRD_C` | 0.0038 | PRD 随机触发增量常数 |
| `CHAT_MAX_TURNS` | 6 | 单次对话工具调用最大轮次 |
| `CHAT_CONTEXT_LIMIT` | 30 | 每群会话上下文最大条目数 |
| `REPLY_MAX_LENGTH` | 500 | 单条回复最大字符数（超过分片） |
| `RATE_LIMIT_WINDOW_MS` | 300000 | 速率限制重置窗口 (5min) |
| `RATE_LIMIT_MAX_REQUESTS` | 10 | 每用户每窗口最大触发次数 |
| `WATCHDOG_INTERVAL_MS` | 5000 | 进程间 ping 间隔 |
| `WATCHDOG_MAX_FAILURES` | 3 | 连续 ping 失败告警阈值 |

---

## 核心模块详解

### 1. P1 — Receiver (`src/receiver/`)

**WsClient** — WebSocket 长连接管理器：
- `connect()`: 建立连接（URL 带 `access_token`），启动心跳 (ping)
- 自动重连：指数退避，上限 30s
- 连接关闭时拒绝未完成请求

**消息处理**：
- **去重**：`recentMessageIds` 滑动窗口 (DEDUP_WINDOW=1000)
- **入库**：所有白名单群消息（含 bot 自身）写入 `chat_messages` 表
- **图片**：提取 `image_urls[]`，异步发送 vision IPC 到 P3
- **bot 自身消息**：正常入库，跳过触发判断，记录 ID 供 reply 检测

**触发判断 (`trigger.ts`)**：
- 四级优先级：AT → reply → keyword → PRD
- PRD 概率累积：每次未触发累加 C，触发后重置为 C
- 返回 `reason` 传递到 P2，用于区分随机插嘴

**RateLimiter (`rate-limiter.ts`)**：
- 维护 `Map<userId, remaining>` 每用户剩余触发次数
- 定时器周期性重置所有用户次数（默认 5 分钟窗口）
- 在触发判断通过后、IPC 发送 P2 前执行次数检查和扣减
- 随机插嘴（`reason="prd"`）不经过用户消息，豁免速率限制

**Send API (`send-api.ts`)**：

| 函数 | OneBot Action | 用途 |
|------|--------------|------|
| `getForwardMsg()` | `get_forward_msg` | 获取合并转发消息内容（解析接收到的 [CQ:forward]） |
| `sendGroupMessage()` | `send_group_msg` | 普通回复主通道 |
| `sendGroupForwardMessage()` | `send_group_forward_msg` | 长文本/对话伪造合并转发（支持非群成员 UID 身份伪造） |
| `sendPoke()` | `send_poke` | 私聊拍一拍 |
| `groupPoke()` | `group_poke` | 群拍一拍（muri_agent QQ fun tool） |
| `sendLike()` | `send_like` | 用户资料卡点赞（muri_agent QQ fun tool） |
| `setGroupReaction()` | `set_group_reaction` | 消息表情回应（muri_agent QQ fun tool） |

**TempMuteList** (`temp-mute-list.ts`)：
- 内存有序数组（按 mute_end_time ASC 排序）
- `mute(userId, muteTime, severeLevel)` — upsert 静音条目，实际时长 = mute_time × severe_level（120s ~ 3000s）
- `checkAndClean(messageTime, userId)` — 惰性清理过期条目 + 禁言判定
- 列表上限 200 条，超限时惰性清理后驱逐最远端
- 无定时器，过期条目在每次 checkAndClean 时惰性移除

### 2. P2 — Conversation Manager (`src/convmgr/`)

**CooldownManager** — 每群独立冷却：
- 首条触发立即回复 → 启动 cooldown timer
- 冷却期内消息缓存到 `msgCache[]`
- CD 到期 → `flushBatch()` 用最新一条缓存消息发起
- `busy` 标志防止并发，不同群并行
- 注意：同群串行化，不同群完全并行

**ContextBuilder** — 上下文构建：
- 从 DB 查询最近 N 条消息 → 逆序为时间升序
- `normalizeNames()`: 同用户统一为最新群名片
- `resolveQuotes()`: 引用消息嵌入 `(↳ MsgID「原文」)`
- `AffinityInjector`: 注入 `{group:xxx, affinity:N}`
- **触发消息段**：触发消息从常规上下文中单独拎出到 `[触发消息]` 段
- 随机插嘴时触发消息段显示「（随机插嘴）」

**静默工具系统**：
- **文本提取** (`silent-text-extractor.ts`)：正则匹配 `getmeme(标签)`、`affinity(id, bool, "印象?")`、`timer(时间, "文本")`、`tts("文本", "语言?", "翻译?")`、`muri_agent("任务")`、`text2image("主题")`
- **执行器** (`silent-tools.ts`)：分流执行 — getmeme 直接执行；timer/affinity 按 `SILENT_TOOL_QUEUE` 配置走任务队列或直接执行；tts/muri_agent/text2image 串行 FIFO 执行
- **任务队列** (`task-queue-manager.ts`)：为需要异步管理的工具（timer/affinity/tts/muri_agent/text2image）提供统一生命周期管理，支持并行/串行调度
  - 并行工具 (timer, affinity)：入队即运行，无并发限制
  - 串行工具 (tts, muri_agent, text2image)：FIFO 槽位锁，同一类型依次执行
  - 日志 (`task-queue-logger.ts`)：记录入队/出队事件，不记录工具内部细节
- 所有标记从文本中移除后再发送

**TimerManager** (`timer-manager.ts`)：
- `set(userId, groupId, durationSec, eventText)` → setTimeout
- 最短 60 秒，自动 clamp
- 到期通过 P1 发送 `[CQ:at,qq=userId] 时间到啦！"事件文本"`
- 支持 `cancel(id)` 和 `list()` 查询

**PostProcessor** (`post-process.ts`)：
- 提取首行动作描述 `（xxx）`
- 关键词匹配情感标签（5 类 + 默认"开心"）
- 纯文本字数 > 50 → `forward`（合并转发），P2 构建 `forward_nodes` 载荷，P1 调用 `send_group_forward_msg` 发送
- ≤ 50 → `normal`（普通文本消息）

### 3. P3 — LLM Core (`src/llmcore/`)

**LLMRelay** — Provider 路由器：
- `chatRaw(messages, tools, model)` → alias 路由到 provider
- 每次创建新 `LLMClient`（无连接池）
- 响应回填 `provider` / `model` / `baseUrl`

**LLMClient** — HTTP 客户端：
- POST `{baseUrl}/chat/completions`
- 支持 `reasoning_effort` 参数
- 重试：5xx/网络 → 5 次（1s 间隔），4xx → 不重试
- 返回标准化 `LLMResponse`

**ConversationLoop** — 主 agent 工具调用循环：
- 最多 `maxTurns` 轮，每轮 LLM + 工具执行
- 注册工具（在 ToolRegistry 中）→ P3 内部执行
- 未注册工具 → 收集到 `silent_tool_calls[]`，由 P2 执行
- **中间回复**：每轮文本通过 `onIntermediateReply` 回调即时推送
- **循环耗尽补救**：maxTurns 耗尽无最终回复时，额外无工具调用一次

**MuriAgentLoop** — 子 agent 独立 LLM 循环（`src/llmcore/muri-agent/loop.ts`）：
- **触发**：主 agent 在回复中写入 `muri_agent("任务描述")` → P2 提取 → IPC 调用 P3
- **Phase 1 — 工具循环**：复用 ConversationLoop + qqFunRegistry（独立 ToolRegistry），执行 QQ 互动工具
  - `group_poke(group_id, user_id)`: 群拍一拍
  - `send_like(user_id, times)`: 用户资料卡点赞
  - `set_group_reaction(message_id, code)`: 消息表情回应 (24 种可选)
  - 所有 QQ 工具通过 `qq_action` IPC → P1 → OneBot action 实际执行
  - 中间文本不发送（不设置 onIntermediateReply），整个执行记录作为 forgery 步骤的上下文
  - Tool call 失败不中断，记录错误后继续 forgery
- **Phase 2 — 聊天记录伪造**：使用 `muri.yaml` preset（母女对话模板 + 时段氛围 + 输出格式约束）
  - 角色：赫萝（母亲，古雅狡黠）和缪里（女儿，活泼跳脱）
  - 输出格式：`---` 分隔，`[角色名]` 头，可选 `（动作）`，必含言语
  - 重试策略：最多 3 次，指数退避 1s→2s→4s
- **Phase 3 — 解析**：`parseDialogueToNodes()` 将 LLM 输出切割为 `ForwardNode[]`
  - 角色名 → user_id 映射：赫萝→<BOT_ID>，缪里→<MURI_BOT_ID>
  - `uin` + `name` 字段实现身份伪造（非群成员 UID 使 name 字段生效）
- **模型路由**：通过 `MURI_AGENT_MODEL` 环境变量指定 provider alias，独立于主 agent 模型

**Vision 系统 (`vision.ts`)**：
- P1 异步发送 vision IPC → P3 `describeImages()`
- 构造多模态消息 → vision 模型 → 文字描述
- `updateContent()` 回填 DB：纯占位符消息替换，含文本消息追加 `[图片描述: xxx]`

**PresetLoader** (`preset-loader.ts`)：
- 解析 YAML 文件 front-matter（无需 js-yaml 依赖）
- 提取 `name`、`trigger_keywords` 和 body system prompt

**ToolRegistry** (`tools/registry.ts`)：
- `register(meta)` — 重名抛错
- `execute(name, args)` — Promise.race 超时保护 + 结果截断
- `getToolDefinitions()` — 返回 OpenAI function calling 格式

**temp_mute 工具** (`tools/builtin/temp-mute.ts`)：
- LLM 通过 function calling 调用，注册在主 agent ToolRegistry 中
- 参数：`user_id`（目标 QQ 号）、`mute_time`（基础时长 120-600s）、`severe_level`（1-5，对应冒犯层级）
- 实际静音时长 = `mute_time × severe_level`（120s ~ 3000s）
- **印象联动**：检查触发用户的历史印象中是否包含冒犯关键词（调戏、越界、冒犯、不敬、挑衅、骚扰、试探、无礼、出言不逊），有则 `severe_level` 自动 +1（上限 5）
- P3 通过 `temp_mute` IPC → P1 TempMuteList 存储
- 静音期间 P1 在 `checkAndClean()` 时跳过该用户的触发判断

**context_review 工具** (`tools/builtin/context-review.ts`)：
- LLM 通过 function calling 调用，注册在主 agent ToolRegistry 中
- 参数：`user_id`（目标 QQ 号）、`limit`（检索条数，默认 40，最大 200）
- 权限：仅触发用户好感度 > 8 时可用（由 P2 在 `ChatPayload.affinity` 中传入）
- 调用 `MessageRepository.findRecentByGroupAndUser()` 查询 DB
- 返回格式化的消息时间线（时间升序，含 MsgID/发送者/内容）
- `requiresFollowUp: true`，LLM 在下一轮综合成自然语言总结回复

**当前注册的工具**：

| 类别 | 工具 | requiresFollowUp | 来源 | 备注 |
|------|------|:---:|------|------|
| 内置 | `get_time` | ✅ | `registerBuiltinTools()` | 主 agent 使用 |
| 内置 | `web_search` | ✅ | `registerBuiltinTools()` | 主 agent 使用 |
| 内置 | `temp_mute` | ✅ | `registerBuiltinTools()` | 主 agent 使用，五级静音 + 印象联动 |
| 内置 | `context_review` | ✅ | `registerBuiltinTools()` | 主 agent 使用，好感度 > 8 可用 |
| MCP-FS | `filesystem_read_file` / `list_directory` / `search_files` 等 14 个 | ✅ | MCP stdio | 主 agent 使用 |
| MCP-RAG | `ragflow_ragflow_retrieval` | ✅ | MCP stdio | 主 agent 使用 |
| QQ Fun | `group_poke` | — | `registerQqFunTools()` | 仅 muri_agent 使用，独立 ToolRegistry |
| QQ Fun | `send_like` | — | `registerQqFunTools()` | 仅 muri_agent 使用，独立 ToolRegistry |
| QQ Fun | `set_group_reaction` | — | `registerQqFunTools()` | 仅 muri_agent 使用，独立 ToolRegistry |

**文本调用工具（静默，不在 ToolRegistry 中）**：

| 工具 | 格式 | 执行方 | 队列 | 说明 |
|------|------|--------|:----:|------|
| `getmeme` | `getmeme(标签)` | P2 | — | 表情图片，直接执行（永不走队列） |
| `affinity` | `affinity(id, bool, "印象?")` | P2 | 可配置 | 好感度变更 + 可选用户印象，排队时追踪 DB 写入 |
| `timer` | `timer(时间, "文本")` | P2 | 可配置 | 定时提醒，排队时追踪生命周期 |
| `tts` | `tts("文本", "语言?", "翻译?")` | P2 | 已实现 | 语音合成 (GPT-SoVITS v2Pro, 串行FIFO), 默认顺序发送 |
| `muri_agent` | `muri_agent("任务")` | P3+P2 | 可配置 | 串行子代理：P3 工具循环 + 对话伪造，P2 合并转发发送 |
| `text2image` | `text2image("主题")` | P2 | 可配置 | 文生图：LLM 提示词生成 → 图片 API → 下载 → 合并转发发送（串行FIFO） |

**MCP 客户端** (`tools/mcp/client.ts`)：
- 支持 stdio (spawn 子进程) 和 SSE (HTTP 流)
- JSON-RPC 2.0: `initialize` → `tools/list` → 注册到 ToolRegistry
- 工具命名：`{serverId}_{toolName}`
- 连接失败记录日志但不阻止启动

### 4. 好感度系统 (`src/convmgr/affinity/`)

**存储格式**：状态字符串 `"5+1+1"` — 首数字为长期好感度 (1-10)，后续 `+1`/`-1` 为短期变更。

**状态机规则**：
1. LLM 写入 `affinity(userId, true/false, "印象?")` → P2 提取 → `addDelta()`
2. 相邻 `+1-1` / `-1+1` → 循环抵消
3. 连续三个同号 → 合并入长期好感度 → 异步写 DB
4. 范围始终在 [1, 10] 截断

**用户印象系统**：
- `affinity()` 第三个可选参数：印象文本（≤10 字），描述用户当前行为特征
- `addImpression(userId, impression)` 追加到用户印象数组（FIFO，最多 10 条）
- `hasOffenseKeywords(impressions)` — 匹配冒犯关键词（调戏、越界、冒犯、不敬、挑衅、骚扰、试探、无礼、出言不逊），供 `temp_mute` 联动升级 severe_level

**上下文注入**：每条用户消息前缀注入 `{group:xxx, affinity:N}`，LLM 据此调整语气和文字量。

### 5. 存储层 (`src/common/db/`)

**chat_messages** — 消息持久化：
- `message_id` 唯一键 (REPLACE 语义，ON DUPLICATE KEY UPDATE)
- `role` 枚举：user / assistant
- `image_urls` JSON 列、`quoted_message_id` 引用列

**user_affinity** — 好感度持久化：
- `user_id` 主键
- `long_term_affinity` + `short_term_changes`

**token_usage** — Token 用量审计：
- `group_id` / `created_at` 索引

### 6. 进程监控 (`src/common/watchdog.ts`)

三进程互相 ping 监控：
- 每个进程定期 ping 另外两个进程
- 连续 `maxFailures` 次失败 → 日志告警
- 非阻塞，不影响正常业务

---

## 配置参考 (.env)

> **配置项定位索引**：所有配置项由两处共同定义 —— 模板在 `.env.example`（复制为 `.env` 后填写），**权威解析与默认值在 `src/common/config.ts` 的 `loadConfig()`**。下表给出各配置组的精确定位，便于查找与回填。
>
> ⚠️ 上传前敏感值（DB 密码、LLM API Key、access token、bot/群 QQ 号等）已清除为占位符，需按需重新填入。

| 配置组 | `config.ts` 解析位置 | `.env.example` 模板位置 |
|--------|----------------------|------------------------|
| 进程端口 | `loadConfig()` 237-239 | §5 进程端口 |
| SnowLuma WebSocket | 240-246 | §19 SnowLuma WebSocket |
| LLM Relay | 247-250（`loadLLMProviders` 157-181） | §26 LLM Relay |
| Chat | 251-277 | §30 Chat |
| MySQL | 278-286 | §10 MySQL |
| MCP | 287（`parseMcpServers` 185-221） | §46 MCP |
| Silent/Task Queue | 288-303 | §101 Silent Tool Task Queue |
| TTS | 304-315 | §53 TTS |
| Text2Image | 316-329 | §75 Text2Image |
| Watchdog | 334-337 | §49 Watchdog |
| Rate Limit | 275-276（Chat 组内） | 仅 `.env`，`.env.example` 未列 |
| Muri Agent | 330-333 | 仅 `.env`，`.env.example` 未列 |

> 说明：`.env.example` 为最小模板，缺少数个仅在实际 `.env` 出现的键（如 `RATE_LIMIT_*`、`MURI_AGENT_*`、`PRESET_NAME`/`PRESET_DIR` 等），完整键位以 `config.ts` 的 `loadConfig()` 为准。

### 进程端口

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `P1_PORT` | `3101` | Receiver IPC 端口 |
| `P2_PORT` | `3102` | ConvMgr IPC 端口 |
| `P3_PORT` | `3103` | LLM Core IPC 端口 |

### SnowLuma WebSocket (P1)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SNOWLUMA_WS_URL` | `ws://127.0.0.1:3001` | WebSocket 端点 |
| `SNOWLUMA_ACCESS_TOKEN` | *(必填)* | 访问令牌 |
| `SNOWLUMA_HEARTBEAT_INTERVAL_MS` | `30000` | 心跳间隔 |
| `SNOWLUMA_RECONNECT_BASE_DELAY_MS` | `1000` | 重连基础延迟 |
| `SNOWLUMA_RECONNECT_MAX_DELAY_MS` | `30000` | 重连最大延迟 |

### MySQL

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DB_HOST` | `127.0.0.1` | 主机 |
| `DB_PORT` | `3306` | 端口 |
| `DB_USER` | `root` | 用户名 |
| `DB_PASSWORD` | *(必填)* | 密码 |
| `DB_DATABASE` | `amyluna` | 数据库名 |
| `DB_POOL_MAX` | `10` | 连接池大小 |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` | 空闲超时 |

### LLM Relay (P3)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_RELAY_DEFAULT_ALIAS` | `LLM` | 默认模型别名 |
| `LLM_PROVIDERS_JSON` | *(必填)* | JSON 数组，支持多 provider |

`LLM_PROVIDERS_JSON` 示例：
```json
[{
  "id": "deepseek",
  "aliases": ["LLM"],
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-v4-flash",
  "enabled": true,
  "maxTokens": 1024,
  "timeoutMs": 30000
}, {
  "id": "sensenova",
  "aliases": ["vision"],
  "baseUrl": "https://token.sensenova.cn/v1",
  "apiKey": "your-vision-api-key",
  "model": "sensenova-6.7-flash-lite",
  "enabled": true,
  "maxTokens": 1024,
  "timeoutMs": 60000
}, {
  "id": "sensenova-muri",
  "aliases": ["muri"],
  "baseUrl": "https://token.sensenova.cn/v1",
  "apiKey": "your-sensenova-api-key",
  "model": "deepseek-v4-flash",
  "enabled": true,
  "maxTokens": 1024,
  "timeoutMs": 60000
}]
```

### Chat (P2)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PRESET_FILE` | `preset/holo.yaml` | 角色 prompt 文件 |
| `BOT_ID` | *(必填)* | Bot QQ 号 |
| `TRIGGER_KEYWORDS` | `赫萝~` | 触发关键词（逗号分隔） |
| `WHITELIST_GROUP_IDS` | *(必填)* | 白名单群号（逗号分隔） |
| `ERROR_ALERT_GROUP_ID` | *(必填)* | 错误告警目标群 |
| `ACCEPT_IMAGES` | `false` | 是否接受图片消息 |
| `VISION_ALIAS` | `vision` | 视觉模型 alias |
| `IMAGE_PROMPT` | *(见 .env.example)* | 图片描述 system prompt |
| `REPLY_MAX_LENGTH` | `500` | 单条回复最大字符 |
| `CHAT_MAX_TURNS` | `6` | 工具调用最大轮次 |
| `CHAT_CONTEXT_LIMIT` | `30` | 上下文条目上限 |
| `CHAT_COOLDOWN_MS` | `10000` | 冷却窗口 (ms) |
| `CHAT_REPLY_TIMEOUT_MS` | `60000` | chat IPC 请求超时 (ms) |
| `PRD_C` | `0.0038` | PRD 随机触发增量常数 C |
| `RATE_LIMIT_WINDOW_MS` | `300000` | 速率限制重置窗口 (ms)，默认 5 分钟 |
| `RATE_LIMIT_MAX_REQUESTS` | `10` | 每用户每窗口最大触发次数 |

### Muri Agent (P3)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MURI_AGENT_MAX_TURNS` | `4` | 子 agent 工具调用最大轮次 |
| `MURI_AGENT_MODEL` | *(空，走默认 LLM)* | 子 agent 模型 alias（如 `muri`），独立于主 agent 模型路由 |

### Text2Image 文生图 (P2)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `T2I_BASE_URL` | `https://token.sensenova.cn/v1` | API 基础地址 |
| `T2I_API_KEY` | *(必填)* | API Key（留空则禁用以色列功能） |
| `T2I_PROMPT_MODEL` | `deepseek-v4-flash` | 提示词生成模型 |
| `T2I_IMAGE_MODEL` | `sensenova-u1-fast` | 图片生成模型 |
| `T2I_IMAGE_SIZE` | `2752x1536` | 图片尺寸 |
| `T2I_OUTPUT_DIR` | `/home/USER/temp_files/text2image/` | 图片暂存目录 |
| `T2I_PROMPT_TIMEOUT_MS` | `60000` | 提示词生成超时 (ms) |
| `T2I_IMAGE_TIMEOUT_MS` | `120000` | 图片生成超时 (ms) |
| `T2I_MAX_RETRIES` | `1` | 网络/5xx 最大重试次数 |
| `T2I_MAX_TOPIC_LEN` | `200` | 最大主题描述长度 |
| `T2I_FILE_TTL_MS` | `86400000` | 图片暂存保留时间 (ms) |
| `T2I_PRESET_PATH` | `preset/text2image.yaml` | 提示词生成系统预设文件路径 |

### Silent Tool Task Queue (P2)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SILENT_TOOL_QUEUE` | *(空)* | 需要通过任务队列管理的工具（逗号分隔）。支持: timer, affinity, tts, muri_agent, text2image |
| `TASK_QUEUE_SERIAL` | `tts,muri_agent,text2image` | 不可并行的工具（逗号分隔），标记为串行 FIFO 执行 |

### TTS 语音合成 (P2)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TTS_BASE_URL` | `http://127.0.0.1:9880` | GPT-SoVITS v2Pro API 地址 |
| `TTS_VOICE` | `holo` | 默认语音角色 |
| `TTS_VOICE_CONFIG_DIR` | `/home/USER/pythonprojects/audiobook_prepose` | 角色配置目录 |
| `TTS_OUTPUT_DIR` | `data/tts/` | 音频临时输出目录 |
| `TTS_SEND_MODE` | `sequential` | 发送策略: sequential / forward-audio / forward-video |
| `TTS_API_TIMEOUT_MS` | `120000` | API 超时 (ms) |
| `TTS_MAX_RETRIES` | `1` | 网络/5xx 最大重试次数 |
| `TTS_MAX_TEXT_LEN` | `300` | 最大合成文本长度 |
| `TTS_DEFAULT_LANG` | `zh` | 默认语言 (lang 参数为空/无效时回退) |
| `TTS_FILE_TTL_MS` | `86400000` | 音频文件保留时间 (ms) |

#### TTS 模型配置

模型权重通过 `{voice}_infer_config.json` 中的 `model` 段配置，合成前调用 `/set_gpt_weights` 和 `/set_sovits_weights` 切换。语言自适应时（如 holo 的 JA 合成）会覆盖为 JA 专用模型路径。

| 语言 | GPT 模型 | SoVITS 模型 |
|------|----------|-------------|
| **ZH** | 不传（API 默认 v2pro 底模） | `SoVITS_weights_v2Pro/holo-陶典_e15_s3375.pth` |
| **JA** | `GPT_weights_v2Pro/holov2-e15.ckpt` | `SoVITS_weights_v2ProPlus/holov4_e20_s3500.pth` |

**推理参数**（`inference` 段，对齐 `batch_multi_seed.py`）：

| 参数 | 值 | 参数 | 值 |
|------|-----|------|-----|
| `speed_factor` | 0.95 | `top_k` | 10 |
| `top_p` | 15 | `temperature` | 0.8 |
| `repetition_penalty` | 1.0 | `sample_steps` | 32 |
| `text_split_method` | `cut3` | `fragment_interval` | 0.3 |
| `parallel_infer` | true | `seed` | 随机 |

**发送格式**（sequential 模式）：
1. 音频 → 独立 record 消息（WAV → base64://）
2. 原文「{text}」+ 译文「（中文翻译：{translation}）」→ 合并为一条文本消息（仅非中文时含翻译）

**Text2ImageExecutor** (`text2image/executor.ts`)：
- LLM 通过 `text2image("主题")` 文本标记调用
- 四阶段流程：
  1. **提示词生成**：调用 LLM API（`T2I_PROMPT_MODEL`），传入 `text2image.yaml` 系统预设 + 用户主题
  2. **图片生成**：调用图片生成 API（`T2I_IMAGE_MODEL`），传入 LLM 生成的提示词
  3. **图片下载**：下载生成的图片到本地暂存目录，支持 URL 和 base64 两种格式
  4. **合并转发发送**：图片（base64 image segment）+ 元数据文本（主题/尺寸/token/耗时）合为一条合并转发卡片
- HTTP 重试策略：4xx 不重试，5xx/网络错误指数退避重试（最多 `T2I_MAX_RETRIES` 次）
- 暂存文件管理：启动时清理超过 `T2I_FILE_TTL_MS` 的旧文件
- 串行 FIFO 执行（默认在 `TASK_QUEUE_SERIAL` 中），等待槽位释放后才调用 API

### MCP (P3)

| 变量 | 说明 |
|------|------|
| `MCP_SERVERS_JSON` | MCP 服务器配置 JSON 数组 |

### Watchdog

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WATCHDOG_INTERVAL_MS` | `5000` | ping 间隔 |
| `WATCHDOG_MAX_FAILURES` | `3` | 告警阈值 |

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 .env
cp .env.example .env
# 编辑 .env：填入 SNOWLUMA_ACCESS_TOKEN、LLM_PROVIDERS_JSON、DB_PASSWORD、
#            WHITELIST_GROUP_IDS、ERROR_ALERT_GROUP_ID 等

# 3. 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS amyluna DEFAULT CHARSET=utf8mb4"

# 4. 类型检查
npm run typecheck

# 5. 启动三个进程（开发模式，文件变更自动重启）
npm run dev:p1    # P1 — Receiver :3101
npm run dev:p2    # P2 — ConvMgr :3102
npm run dev:p3    # P3 — LLM Core :3103
```

**启动顺序建议**：P3 → P2 → P1（先启动 LLM Core，再启动 IPC 的客户端方）。

**PM2 部署**：
```bash
pm2 start ecosystem.config.js
```

**启动流程**：
1. 加载 `.env` 配置
2. 创建 MySQL 连接池 + 自动建表（`chat_messages` / `user_affinity` / `token_usage`）
3. 初始化好感度系统（加载 DB 到内存缓存）
4. 加载 preset YAML 并拼接 system prompt（好感度指南 + 回复格式约束）
5. 注册内置工具 (`get_time`、`web_search`)
6. 连接 MCP 服务器（失败不阻止启动）
7. 各进程启动 IPC Server → 后台 connect peers → Watchdog 启动
8. P1 连接 SnowLuma WS → 开始监听消息

---

## 关键设计原则

1. **三进程独立**：P1/P2/P3 各自独立重启，IPC 断线自动重连，单进程故障不波及其他
2. **关注点分离**：P1 只管传输层（WS + API），P2 只管会话协调（冷却/上下文/静默工具），P3 只管 LLM（调用/工具循环/vision）
3. **静默工具下沉到 P2**：`get_meme`、`affinity`、`timer` 不在 P3 ToolRegistry 中，LLM 通过文本标记调用，P2 提取并执行
4. **文本标记机制**：LLM 将静默工具调用嵌入回复文本，P2 正则提取后清洗文本再发送，用户看不到标记
5. **上下文从 DB 构建**：P2 不再维护内存队列，每次触发从 MySQL 查询最近消息，各进程可独立重启
6. **触发消息独立标注**：触发消息从常规上下文中单独拎出到 `[触发消息]` 段，随机插嘴时显示「（随机插嘴）」，LLM 可据此调整行为
7. **冷却批处理**：同群冷却期内消息合并，CD 到期用最新一条触发，防止高频发送
8. **注入器模式**：外部参数（好感度、group_id）通过 `ContextInjector` 接口注入，不硬编码
9. **后处理解耦**：`PostProcessor` 在 LLM 返回和消息发送之间插入，可独立扩展
10. **发送不重试**：QQ 消息发送失败不自动重试，防止触发平台风控
11. **好感度状态机**：短期变更先抵消后合并，相邻相反操作不产生永久影响
12. **Vision 异步回填**：图片描述异步执行，先 `ack` 响应 P1，后回填 DB
13. **中间回复即时推送**：工具调用循环中每轮文本通过回调立即发送，仅最终回复携带表情包
14. **循环耗尽补救**：maxTurns 耗尽无最终答案时，额外无工具调用一次 LLM
15. **进程间互相 watchdog**：三进程互相 ping，连续失败告警
16. **IPC 异步并发**：同一连接上多个 handler 可并发执行（`void` 调用），不同群对话和 vision 请求完全并行
17. **Bot 消息全量入库**：bot 自身消息正常存入 DB 和上下文，供引用检索和 reply 触发判断
18. **好感度长期记忆**：重启后从 DB 加载，跨会话保留，影响 LLM 回复语气和文字量
19. **速率限制在 P1 侧**：触发判断后、IPC 发送前执行次数检查，随机插嘴豁免。周期性窗口重置，防止单用户高频刷屏
20. **任务队列不干预执行**：TaskQueue 只管理静默工具的生命周期（入队/调度/完成/资源释放），不改变工具内部执行逻辑。对并行工具（timer/affinity）入队即执行；对串行工具（tts/muri_agent）按 FIFO 调度
21. **静默工具分流**：getmeme 始终直接执行；timer/affinity 根据 `SILENT_TOOL_QUEUE` 配置决定走任务队列还是直接执行；muri_agent 串行 FIFO 执行；tts 通过 TtsExecutor 执行，支持 sequential/forward-audio/forward-video 三种发送模式
22. **子 agent 工具隔离**：QQ fun tools（group_poke / send_like / set_group_reaction）注册在独立的 qqFunRegistry 中，仅 MuriAgentLoop 使用，主 agent (holo) 无法感知或调用
23. **合并转发身份伪造**：muri_agent 利用 `send_group_forward_msg` 的非群成员 UID 特性，使用 `uin`+`name`（而非 `user_id`+`nickname`）实现赫萝和缪里的独立身份卡片，不需要这些 UID 在群内
24. **子 agent 独立模型路由**：muri_agent 通过 `MURI_AGENT_MODEL` 配置独立 provider alias，可走单独的 API 端点/模型，不占用主 agent 的上下文或限流
25. **文生图四阶段流水线**：Text2ImageExecutor 将 LLM 提示词生成 → 图片 API → 下载 → 合并转发发送分离为独立阶段，任一阶段失败即提前终止并通知触发群
26. **好感度印象记忆**：affinity() 支持可选的第三个参数记录用户印象（≤10 字），FIFO 管理最多 10 条。印象中的冒犯关键词与 temp_mute 联动，自动升级静音等级
27. **五级静音系统**：temp_mute 的 severe_level 1-5 直接对应角色预设中「面对挑逗与冒犯的应对」五级系统，实际静音时长 = mute_time × severe_level（120s ~ 3000s）
28. **静音惰性清理**：TempMuteList 无定时器，过期条目在每次消息到达的 `checkAndClean()` 中惰性移除，按 `mute_end_time` ASC 排序以优化清理效率
29. **好感度门控工具**：context_review 基于触发用户的好感度（> 8）进行权限校验，好感度由 P2 在 ChatPayload 中传入 P3，不依赖 LLM 自行判断
30. **Text2Image 合并转发发送**：图片 + 元数据作为一个合并转发卡片的两条消息，避免图片与描述分离，用户体验更好

---

## 日志系统

- **主日志** `logs/YYYY-MM-DD.log`：结构化 JSON 行，`ts`/`level`/`module`/`event` + 上下文字段
- **LLM 响应日志** `logs/llm-YYYY-MM-DD.log`：每次 API 调用的完整响应结构
- 日志带进程标签：`P1.xxx` / `P2.xxx` / `P3.xxx`，可区分来源
- 事件名遵循 `noun.verb` 约定
- 绝不记录 access token、API key 或完整消息文本内容

---

## 开发

```bash
npm run typecheck    # 严格 TypeScript 类型检查
npm run dev:p1       # P1 Receiver — tsx watch
npm run dev:p2       # P2 ConvMgr — tsx watch
npm run dev:p3       # P3 LLM Core — tsx watch
npm run build        # tsc → dist/
npm run start:p1     # 运行 P1 编译产物
npm run start:p2     # 运行 P2 编译产物
npm run start:p3     # 运行 P3 编译产物
```

依赖：`ws` (WebSocket)、`mysql2` (MySQL)、`dotenv` (配置)。全部纯 JavaScript，无需原生编译。

## 与 v1 的主要区别

| 方面 | v1 (snowluma_adapter) | v2 (amyluna) |
|------|----------------------|-------------|
| 架构 | 单进程 | 三进程 (P1/P2/P3) |
| 通信 | 内存函数调用 | TCP JSON-line IPC |
| 上下文 | ChatSession 内存队列 | DB 查询构建 |
| 图片处理 | ChatSession 同步预处理 | P1→P3 异步 IPC，DB 回填 |
| 工具执行 | 全部在单进程内 | P3 执行注册工具，P2 执行静默工具 |
| 静默工具 | block 机制 + ensureMemeUrl | 文本标记提取 + 清洗 + 任务队列分流 |
| 好感度 | 同一模块内 | P2 独立模块，ContextInjector 注入 |
| 触发标记 | `[↑]` 箭头 | `[触发消息]` 独立段 |
| 定时提醒 | 不支持 | TimerManager 支持 |
| 任务队列 | 不支持 | TaskQueueManager 并行/串行调度 |
| 部署 | 单进程重启 | 三进程独立重启 |
