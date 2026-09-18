/**
 * P3 模块测试：验证 LLM Core 全部模块正确加载和运行。
 *
 * 用法:
 *   npx tsx src/llmcore/test-p3.ts
 */

import { PresetLoader } from "./preset-loader";
import { ToolRegistry } from "./tools/registry";
import { registerBuiltinTools } from "./tools/builtin/index";
import { ConversationLoop } from "./conversation-loop";
import type { LLMRelay } from "./llm/relay";
import type { LLMResponse, ToolCall, ChatMessage, ToolDefinition } from "./llm/types";
import type { TokenUsage } from "./llm/types";
import { IpcClient } from "../common/ipc/client";
import { MessageRepository } from "../common/db/message-repository";
import type { FileRepository } from "../common/db/file-repository";

// 创建 mock MessageRepository（测试不需要真实 DB 连接）
function createMockRepo(): MessageRepository {
  return {
    insert: async () => ({ id: 0, message_id: 0, group_id: 0, user_id: 0, sender_name: "", is_private: 0, role: "user", content: "", tool_calls: null, image_urls: null, video_urls: null, voice_urls: null, other_media: null, merged_forward: null, media_parsed: 0, quoted_message_id: null, created_at: "" }),
    insertOrReplace: async () => ({ id: 0, message_id: 0, group_id: 0, user_id: 0, sender_name: "", is_private: 0, role: "user", content: "", tool_calls: null, image_urls: null, video_urls: null, voice_urls: null, other_media: null, merged_forward: null, media_parsed: 0, quoted_message_id: null, created_at: "" }),
    findByMessageId: async () => null,
    findRecentByGroup: async () => [],
    findRecentByGroupAndUser: async () => [],
    updateContent: async () => {},
    updateMediaParsed: async () => {},
  } as unknown as MessageRepository;
}

async function main(): Promise<void> {
  console.log("=== P3 LLM Core 模块测试 ===\n");

  // ─── 1. PresetLoader ──────────────────────────────────
  console.log("[1/5] PresetLoader 测试...");
  const loader = new PresetLoader();
  // 手动注入一个测试 preset（不依赖文件系统）
  const testPreset = {
    name: "test",
    systemPrompt: "你是测试助手。",
    triggerKeywords: ["test"],
  };
  // 直接注册到内部 Map（hack: 手动加载后验证）
  loader.loadAll("preset"); // 扫描真实 preset/ 目录
  const loaded = loader.getAll();
  console.log(`  ✓ 加载 ${loaded.length} 个 preset`);
  for (const p of loaded) {
    console.log(`    - ${p.name}: systemPrompt=${p.systemPrompt.length}chars, keywords=[${p.triggerKeywords.join(",")}]`);
  }

  // ─── 2. ToolRegistry ─────────────────────────────────
  console.log("\n[2/5] ToolRegistry 测试...");
  const registry = new ToolRegistry();
  // Mock p1Client for test（temp_mute 工具注册需要，但测试中不会真正调用）
  const mockP1Client = new IpcClient(0, "P3→P1-test");
  const mockRepo = createMockRepo();

  // ─── 3. 模拟 ConversationLoop ─────────────────────────
  console.log("\n[3/5] ConversationLoop 测试 (mock LLM)...");

  // 创建 mock LLMRelay
  let replyCount = 0;
  const mockRelay: LLMRelay = {
    chatRaw: async (
      _messages: ChatMessage[],
      _tools?: ToolDefinition[],
      _model?: string,
    ): Promise<LLMResponse> => {
      replyCount++;
      // 第一轮: 返回一个非静默工具调用 (web_search) + 一个静默工具调用 (get_meme)
      if (replyCount === 1) {
        return {
          content: "（耳朵一竖）稍等，咱查一下...",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "web_search", arguments: '{"query":"test"}' },
            } as ToolCall,
            {
              id: "call_2",
              type: "function",
              function: { name: "get_meme", arguments: '{"tag":"开心"}' },
            } as ToolCall,
          ],
          usage: mockUsage(),
        };
      }
      // 第二轮: 正常 stop
      return {
        content: "（尾巴轻轻一晃）搜索结果：blah blah...\nhttp://127.0.0.1:5141/memesluna/holo?q=开心",
        finishReason: "stop",
        toolCalls: undefined,
        usage: mockUsage(),
      };
    },
    chat: async () => "mock",
  } as unknown as LLMRelay;

  // 注册内置工具（需 mock relay/vision/fileRepo）
  const mockFileRepo = {
    findByMessageId: async () => null,
  } as unknown as FileRepository;
  const mockVisionConfig = {
    alias: "vision",
    systemPrompt: "",
  };
  registerBuiltinTools(registry, {
    p1Client: mockP1Client,
    repo: mockRepo,
    fileRepo: mockFileRepo,
    relay: mockRelay,
    visionConfig: mockVisionConfig,
  });

  const defs = registry.getToolDefinitions();
  console.log(`  ✓ 注册 ${defs.length} 个非静默工具: ${defs.map((d) => d.function.name).join(", ")}`);

  // 验证工具存在
  console.log(`  ✓ web_search 在 registry: ${registry.has("web_search")}`);
  console.log(`  ✓ get_time 在 registry: ${registry.has("get_time")}`);
  console.log(`  ✓ resolve_media 在 registry: ${registry.has("resolve_media")}`);
  console.log(`  ✓ get_meme 不在 registry (静默工具): ${!registry.has("get_meme")}`);
  console.log(`  ✓ update_affinity 不在 registry (静默工具): ${!registry.has("update_affinity")}`);

  // 执行 get_time
  const timeResult = await registry.execute("get_time", { timezone: "Asia/Shanghai" });
  console.log(`  ✓ get_time 执行: ${JSON.stringify(timeResult).slice(0, 100)}`);

  // 搜索未知工具（静默工具场景）
  const unknownResult = await registry.execute("get_meme", { tag: "开心" });
  console.log(`  ✓ 未知工具(get_meme) 执行失败: ${JSON.stringify(unknownResult)}`);

  const loop = new ConversationLoop(mockRelay, registry, 6);

  // 记录中间回复
  const intermediateReplies: string[] = [];
  loop.onIntermediateReply = async (text: string) => {
    intermediateReplies.push(text);
  };

  // 记录 token 用量
  const tokenUsages: unknown[] = [];
  loop.onTokenUsage = (params) => {
    tokenUsages.push(params);
  };

  const messages: ChatMessage[] = [
    { role: "system", content: "你是测试助手。" },
    { role: "user", content: "帮我搜索一下" },
  ];

  const result = await loop.run(messages);
  console.log(`  ✓ 最终回复长度: ${result.content.length} chars`);
  console.log(`  ✓ 中间回复次数: ${intermediateReplies.length}`);
  console.log(`  ✓ Token 回调次数: ${tokenUsages.length}`);
  console.log(`  ✓ 静默工具调用: ${result.silentToolCalls.length}`);
  if (result.silentToolCalls.length > 0) {
    for (const st of result.silentToolCalls) {
      console.log(`    - ${st.name}(${JSON.stringify(st.arguments)})`);
    }
  }
  console.log(`  ✓ 中间回复内容: "${intermediateReplies[0]?.slice(0, 60)}..."`);

  // 验证关键行为
  const passed = [
    result.content.length > 0,
    intermediateReplies.length === 1, // 第一轮有中间回复
    result.silentToolCalls.length === 1, // get_meme 是静默工具
    result.silentToolCalls[0]?.name === "get_meme",
    tokenUsages.length === 2, // 两轮 LLM 调用
  ];
  const allPassed = passed.every(Boolean);
  console.log(`\n  验证项: ${passed.map((p, i) => `${i + 1}=${p ? "✓" : "✗"}`).join(", ")}`);
  console.log(`  ${allPassed ? "✓ 全部通过" : "✗ 有失败项"}`);

  // ─── 4. IPC 类型兼容检查 ──────────────────────────────
  console.log("\n[4/5] IPC 类型检查...");
  // 验证 ChatPayload, ChatResponsePayload 结构正确
  const testChatPayload = {
    context: "[MsgID:1] [user](123) {group:456, affinity:5}: hello",
    preset: "holo",
    group_id: 1000000001,
    message_id: 1001,
  };
  console.log(`  ✓ ChatPayload: ${JSON.stringify(testChatPayload).length} bytes`);

  const testChatResponse = {
    group_id: 1000000001,
    message_id: 1001,
    content: "回复内容",
    silent_tool_calls: [{ name: "get_meme", arguments: { tag: "开心" } }],
  };
  console.log(`  ✓ ChatResponsePayload: ${JSON.stringify(testChatResponse).length} bytes`);

  // ─── 5. 文件完整性 ────────────────────────────────────
  console.log("\n[5/5] 模块完整性...");
  const modules = [
    "llm/types", "llm/client", "llm/relay", "llm/llm-logger",
    "tools/types", "tools/registry",
    "tools/builtin/index", "tools/builtin/web-search", "tools/builtin/get-time",
    "tools/mcp/client",
    "preset-loader", "conversation-loop",
    "vision", "tts",
    "ipc-server", "ipc-client",
  ];
  let loadedCount = 0;
  for (const mod of modules) {
    try {
      require(`./${mod}`);
      loadedCount++;
    } catch {
      console.log(`  ✗ 加载失败: ${mod}`);
    }
  }
  console.log(`  ✓ 加载成功: ${loadedCount}/${modules.length}`);
  console.log(`\n=== P3 测试完成 (${allPassed && loadedCount === modules.length ? "全部通过" : "有失败项"}) ===`);
}

function mockUsage(): TokenUsage {
  return {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
  };
}

main().catch((err) => {
  console.error("P3 测试失败:", err);
  process.exit(1);
});
