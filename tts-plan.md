# TTS 语音合成工具 — 开发计划

## Context

amyluna 中 TTS 工具目前为占位状态：`TtsCall` 只有 `text` 字段，提取逻辑未实现，执行器为 TODO 注释。需要将其实现为完整的语音合成静默工具，对接 GPT-SoVITS v2Pro API（`127.0.0.1:9880`），支持 LLM 通过文本标记 `tts("文本", "语言", "中文翻译")` 调用，合成后以合并转发形式发出音频+文字+译文。

## ⚠️ 关键约束：Docker 文件隔离

**SnowLuma 运行在 Docker 容器中**，无法访问宿主机文件系统。因此：
- SoVITS 生成的 WAV 文件**不能**通过 `file://` 路径直接传给 OneBot
- **必须**在 P1 侧将 WAV 文件读入内存，转为 `base64://` 编码后嵌入 record 消息段
- 这与现有 meme 图片处理模式一致（`receiver/ipc-server.ts` 的 `downloadMemeToBase64`）
- 数据流：SoVITS → WAV 写入宿主机 `data/tts/` → P2 传路径给 P1 → P1 `readFile` → `base64://` → WS 发送

---

## 1. 设计概要

### 调用格式

```
tts("待合成文本", "zh")                              # 中文，无翻译
tts("こんにちは、元気？", "ja", "你好呀，过得怎么样？")  # 非中文，带翻译
```

- 参数 1（必填）：待合成文本，≤100 字
- 参数 2（可选）：语言标签 `zh|ja|en|ko|yue`，默认 `zh`
- 参数 3（可选）：中文翻译。非中文时 LLM 必须提供

### 发送策略（三选一，由 `TTS_SEND_MODE` 控制）

已通过测试验证：**QQ 合并转发中 record 音频段发送不报错但无法播放**（QQ 端 bug）。

| 模式 | 配置值 | 状态 | 行为 |
|------|--------|:---:|------|
| 顺序发送 | `sequential` | ✅ 默认 | 先发音频消息 → 再发原文 → 再发译文（如有），三条独立消息依次发送 |
| 音频合并转发 | `forward-audio` | ⚠️ 保留 | 音频+文字放入合并转发卡片，等待 QQ 修复此 bug |
| 视频合并转发 | `forward-video` | 🔧 占位 | WAV→MP4 转换后放入合并转发卡片，`wavToVideo()` 函数预留 |

**顺序发送模式**（当前可用方案）的发送序列：
1. 音频消息：`[CQ:record,file=base64://...]` — 独立语音消息，QQ 内可直接播放
2. 原文消息：`「{待合成文本}」` — 紧跟音频的纯文本
3. 译文消息：`（中文翻译：{translation}）` — 仅非中文时发送

### 语音选择

语言 → 角色配置映射，由 `VoiceRegistry` 管理：
- 默认角色 `holo`（`TTS_VOICE` 配置）
- 优先查找 `{voice}_{lang}_infer_config.json`，回退 `{voice}_infer_config.json`
- holo 的日文合成通过 `aux_ref_audio_paths`（5 个 ja 参考音频）支持跨语言合成

### 串行执行

SoVITS 使用全局 TTS pipeline，并发推理会冲突。通过 `TaskQueueManager.waitForRunning()` 确保只有获得串行槽位后才调用 API，中途取消通过 `AbortController` 中断。

---

## 2. 文件变更清单

### 2.1 新建：`src/convmgr/tts/types.ts`

```ts
TtsLang = "zh" | "en" | "ja" | "ko" | "yue" | "auto"
TtsSendMode = "sequential" | "forward-audio" | "forward-video"
VoiceConfig { name, refAudioPath, promptLang, promptText, auxRefAudioPaths, inference: {...} }
TtsExecutorOptions { p1Client, taskQueue, botId, registry, client, outputDir, defaultLang, maxTextLen, fileTtlMs, sendMode }
```

### 2.2 新建：`src/convmgr/tts/voices.ts`

`VoiceRegistry` 类：
- `load(): boolean` — 扫描 `TTS_VOICE_CONFIG_DIR`，加载 `{voice}_infer_config.json`；失败返回 false，不阻止 P2 启动
- `resolve(lang): VoiceConfig | null` — 语言 → 配置查找（优先 `{voice}_{lang}_infer_config.json`，回退基础配置）

### 2.3 新建：`src/convmgr/tts/so-vits-client.ts`

`SoVitsClient` 类：
- `synthesize({text, textLang, voice}): Promise<Buffer>` — POST `{baseUrl}/tts`，返回 WAV 字节
- 超时 120s（`AbortController`），网络/5xx 重试 1 次，4xx 不重试
- 校验响应头 `RIFF`+`WAVE` magic bytes

### 2.4 新建：`src/convmgr/tts/executor.ts`

`TtsExecutor` 类（参考 `MuriAgentExecutor` 结构）：

```
execute(call, groupId, taskId?) 流程:
1. enabled 检查 → 否则 fail
2. taskId 存在 → waitForRunning(taskId)；false → 中止
3. text 非空 + ≤maxTextLen 校验
4. lang 白名单校验 → 回退 defaultLang
5. registry.resolve(lang) → VoiceConfig
6. client.synthesize() → WAV Buffer
7. 保存 outputDir/tts-{ts}-{seq}.wav
8. 根据 sendMode 分发发送策略（见下方）
9. taskQueue.transition(completed|failed)
```

**发送策略分发**：

```ts
// TtsExecutor 内部
private async sendResult(audioPath: string, call: TtsCall, groupId: number): Promise<void> {
  switch (this.options.sendMode) {
    case "sequential":
      return this.sendSequential(audioPath, call, groupId);   // 当前默认
    case "forward-audio":
      return this.sendForwardAudio(audioPath, call, groupId);  // 保留，QQ 端 bug
    case "forward-video":
      return this.sendForwardVideo(audioPath, call, groupId);  // 占位
  }
}
```

**`sendSequential()`** — 顺序发送（当前默认，QQ 端已验证可用）：
1. `p1Client.request("send_message", {group_id, message, method:"normal", tts_audio: audioPath})` → P1 发 base64 record 消息
2. `p1Client.request("send_message", {group_id, message: "「" + call.text + "」"})` → P1 发原文
3. 若 `call.translation` 存在 → `p1Client.request("send_message", {group_id, message: "（中文翻译：" + call.translation + "）"})`

**`sendForwardAudio()`** — 音频合并转发（保留，当前不可用）：
- 构造 `ForwardNode[]: [record(audioPath), text(原文), text(译文)]`
- `p1Client.request("send_message", {method:"forward", forward_nodes})`
- 已知问题：QQ 端合并转发中 record 段无法播放

**`sendForwardVideo()`** — 视频合并转发（占位）：
- 调用 `wavToVideo(audioPath)` → MP4 文件路径（预留函数，当前抛出 "not implemented"）
- 构造 `ForwardNode[]: [video(mp4Path), text(原文), text(译文)]`
- `p1Client.request("send_message", {method:"forward", forward_nodes})`

**`wavToVideo(wavPath: string): Promise<string>`** — 音频转视频占位函数：
```ts
// TODO: 使用 ffmpeg 将 WAV + 静态封面图合成为 MP4
// ffmpeg -loop 1 -i cover.png -i audio.wav -c:v libx264 -tune stillimage \
//   -c:a aac -b:a 192k -pix_fmt yuv420p -shortest output.mp4
throw new Error("wavToVideo not implemented");
```

启动时清理 `outputDir` 中超过 `fileTtlMs` 的旧文件。

### 2.5 修改：`src/convmgr/silent-text-extractor.ts`

- `TtsCall` 增加 `lang?: string; translation?: string`
- `TTS_RE` 改为三捕获组正则 `/tts\(\s*"([^"]*)"\s*(?:,\s*"([^"]*)")?\s*(?:,\s*"([^"]*)")?\s*\)/g`
- 新增 `── 提取 tts() ──` 块：取最后一条有效调用（text 非空），lang/translation 可选
- 清洗文本时增加 `TTS_RE` 替换
- `extractSilentCalls()` 返回实际的 `ttsCall` 而非 `null`

### 2.6 修改：`src/convmgr/silent-tools.ts`

- `SilentToolExecutorOptions` 增加 `ttsExecutor?: TtsExecutor`
- 步骤 4 占位替换为分流逻辑：
  - 排队路径：`executeTtsQueued()` — `enqueue("tts")` → `executor.execute()` + 生命周期管理
  - 直接路径：`executeTtsDirect()` — fire-and-forget

### 2.7 修改：`src/convmgr/task-queue-manager.ts`

新增 `waitForRunning(taskId, timeoutMs=60000): Promise<boolean>`：
- 50ms 轮询等待任务转为 `running`
- 任务被移除/失败/取消 → 返回 false；超时 → 返回 false

### 2.8 修改：`src/convmgr/index.ts`

- 在 MuriAgentExecutor 之后构建 TTS 栈（VoiceRegistry + SoVitsClient + TtsExecutor）
- 将 `ttsExecutor` 传入 `silentToolOptions`
- TTS 注册描述改为 `"语音合成（串行）"`

### 2.9 修改：`src/common/config.ts`

新增 `tts` 配置切片（10 个环境变量）：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TTS_BASE_URL` | `http://127.0.0.1:9880` | SoVITS API |
| `TTS_VOICE` | `holo` | 默认角色 |
| `TTS_VOICE_CONFIG_DIR` | `/home/USER/pythonprojects/audiobook_prepose` | 角色配置目录 |
| `TTS_OUTPUT_DIR` | `data/tts/` | 音频临时目录 |
| `TTS_SEND_MODE` | `sequential` | 发送策略：`sequential` / `forward-audio` / `forward-video` |
| `TTS_API_TIMEOUT_MS` | `120000` | API 超时 |
| `TTS_MAX_RETRIES` | `1` | 重试次数 |
| `TTS_MAX_TEXT_LEN` | `300` | 最大文本长度 |
| `TTS_DEFAULT_LANG` | `zh` | 默认语言 |
| `TTS_FILE_TTL_MS` | `86400000` | 音频文件保留时间 |

### 2.10 修改：`src/common/types/ipc.ts`

- `ForwardNode` 增加 `message?: string | MessageSegment[]` 字段
- `SendMessagePayload` 增加 `tts_audio?: string`（WAV 文件绝对路径，P1 负责读取→base64→发送 record 消息）

### 2.11 修改：`src/receiver/ipc-server.ts`

- 新增 `fileToBase64(path)` 工具函数（`fs.promises.readFile` → `base64://`）
- `send_message` handler 增加 `tts_audio` 处理：若 `payload.tts_audio` 存在，读取文件转 base64，发送 `[CQ:record,file=base64://...]` 格式的群消息
- 保留 `forward_nodes` 中的 record 路径→base64 转换（用于 `forward-audio` 模式）
- 读取失败时发送 `"[语音合成失败，请重试]"`

### 2.12 修改：`preset/holo.yaml`

在第二类（文本调用工具）中新增 `tts()` 说明段：
- 触发场景：用户要求「说一句」「用声音说」「语音」
- 调用格式与正确/错误示例
- 约束：≤100 字、保持角色口吻、非中文必须带翻译

### 2.13 修改：`.env.example` + `.env`

- 新增 9 个 `TTS_*` 配置项
- `SILENT_TOOL_QUEUE` 增加 `tts`：`SILENT_TOOL_QUEUE=timer,affinity,tts,muri_agent`

### 2.14 修改：`README.md`

- 更新 TTS 相关行（占位 → 已实现）
- 文件树增加 `convmgr/tts/`
- 静默工具表格更新 TTS 格式

---

## 3. 数据流

### 默认模式：`sequential`（当前可用）

```
LLM 回复含 tts("こんにちは", "ja", "你好")
  │
  ▼ P2 extractSilentCalls()
TtsCall { text, lang:"ja", translation:"你好" }  +  cleanedText（标记已移除）
  ├─ 主回复（清洗后文本）→ send_message → QQ（用户立即看到）
  └─ silentTools.executeExtracted() → 走任务队列
       └─ enqueue("tts") → waitForRunning() → TtsExecutor.execute()
            ├─ VoiceRegistry.resolve("ja") → holo_infer_config.json
            ├─ SoVitsClient.synthesize() → WAV Buffer
            ├─ 保存 data/tts/tts-{ts}-{seq}.wav
            └─ sendSequential() 顺序发送:
                 ├─ send_message({tts_audio: "/path/to.wav"})
                 │    ▼ P1 fileToBase64() → [CQ:record,file=base64://...] → QQ
                 ├─ send_message({message: "「こんにちは」"})
                 │    ▼ P1 → QQ 纯文本
                 └─ send_message({message: "（中文翻译：你好）"})
                      ▼ P1 → QQ 纯文本
```

### 保留模式：`forward-audio`（QQ 端 bug，等待修复）

```
TtsExecutor.execute() → sendForwardAudio()
  └─ send_message({method:"forward", forward_nodes: [record(path), text, translation]})
       ▼ P1 resolveRecordSegments() → base64://
         → sendGroupForwardMessage() → QQ 合并转发卡片
         ⚠️ 已知问题：卡片中音频节点无法播放
```

### 占位模式：`forward-video`（待实现）

```
TtsExecutor.execute() → sendForwardVideo()
  ├─ wavToVideo(wavPath) → MP4  # 占位，抛出 not implemented
  └─ send_message({method:"forward", forward_nodes: [video(mp4Path), text, translation]})
```

---

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| SoVITS 不可用 | 重试 1 次 → task failed，队列继续 |
| API 超时(>120s) | AbortController 中断 → 同上 |
| 响应非 WAV | fail `"invalid.wav"` |
| 文本为空 | warn + skip |
| 文本超长 | fail，日志记录 |
| lang 无效 | 回退 defaultLang + warn |
| 非中文无翻译 | 跳过翻译节点 + warn |
| 语音配置缺失 | `enabled=false`，所有 TTS 调用快速失败 |
| 排队中取消 | waitForRunning 检测到 failed → 中止 |
| 运行中取消 | onCancel → AbortController.abort() |
| 文件写入失败 | fail，日志 `tts.saveFail` |

---

## 5. 实现顺序

### Step 0: 项目备份

```bash
mkdir -p /home/USER/amyluna_backup
tar -czf /home/USER/amyluna_backup/amylunav2.2-0809.tar.gz \
  -C /home/USER/amyluna \
  --exclude='node_modules' --exclude='dist' --exclude='data' --exclude='logs' \
  src/ preset/ package.json tsconfig.json ecosystem.config.js .env .env.example start.sh
```

备份范围：`src/`、`preset/`、配置文件（排除 `node_modules`、`dist`、`data`、`logs` 等可重新生成的内容）。

### Step 1: SL/QQ 合并转发 + 音频消息能力验证 ✅ 已完成

**验证结果**：
- ✅ SoVITS API 正常：HTTP 200，11.3s 合成 101KB RIFF WAV
- ✅ 纯文本合并转发正常：卡片可展开
- ❌ **合并转发中 record 段发送不报错但无法播放**（QQ 端 bug）

**结论**：默认使用 `sequential` 模式（顺序发送独立消息），保留 `forward-audio` 等待 QQ 修复，预留 `forward-video`（WAV→MP4）占位。

### Step 2: SoVITS 冒烟测试

curl 验证 API 可用：
```bash
curl -X POST http://127.0.0.1:9880/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"咱是贤狼赫萝","text_lang":"zh","ref_audio_path":"/home/USER/桌面/refer_audio/holo/zh/陶典_01.mp3","prompt_lang":"zh","prompt_text":"北斗姐可是璃月名人","speed_factor":0.9,"seed":-1,"media_type":"wav"}' \
  -o /tmp/tts-smoke.wav
file /tmp/tts-smoke.wav  # 期望: RIFF (little-endian) WAVE audio
```

### Step 3: 提取层

修改 `silent-text-extractor.ts`（TtsCall/正则/提取/清洗）

### Step 4: 类型+配置

`ipc.ts` ForwardNode + `config.ts` tts 切片

### Step 5: TTS 模块

types → voices → so-vits-client → executor

### Step 6: 集成接入

`task-queue-manager.ts` waitForRunning → `silent-tools.ts` → `index.ts` → `.env`

### Step 7: P1 音频转发

`receiver/ipc-server.ts` 路径→base64 转换

### Step 8: Preset 更新

`holo.yaml` TTS 使用说明

### Step 9: 端到端验证

重启 P2+P1，发送「赫萝~ 用语音说句话」验证全流程

---

## 6. 验证方案

### 6.0 SL/QQ 合并转发 record 能力验证 ✅ 已完成

- ✅ SoVITS 合成正常（见 Step 2）
- ✅ 纯文本合并转发正常
- ❌ 合并转发中 record 段无法播放 → 默认使用 `sequential` 模式

### 6.1 提取单元测试

各参数组合的 TTS 标记提取+清洗

### 6.2 串行机制验证

两个群同时触发 TTS，确认第二个等待第一个完成后才执行

### 6.3 合成集成测试

对 live SoVITS 调 synthesize()，断言 WAV 有效 + RIFF 头

### 6.4 端到端 QQ 测试

完整流程：文字回复立即可见 + 合并转发卡片（音频+原文+译文）。验证 base64 WAV 在 QQ 中的播放效果

### 6.5 故障演练

SoVITS 关闭 → task failed + 队列不阻塞；恢复后正常

### 6.6 音频质量

人工听 zh/ja 合成效果
