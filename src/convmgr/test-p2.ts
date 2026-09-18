/**
 * P2 Conversation Manager 模块测试。
 *
 * 用法:
 *   npx tsx src/convmgr/test-p2.ts
 */
import {
  parseAffinity,
  formatAffinity,
  effectiveAffinity,
  clampAffinity,
} from "./affinity/types";
import { AffinityCache } from "./affinity/cache";
import { AffinityInjector } from "./affinity/injector";
import type { ContextEntry } from "./affinity/types";
import { CooldownManager } from "./cooldown";
import type { CooldownTriggerEntry } from "./cooldown";
import { createDecomposePostProcessor, createNoopPostProcessor } from "./post-process";
import { SilentToolExecutor } from "./silent-tools";
import { loadConfig } from "../common/config";
import { createPool } from "../common/db/pool";
import { MessageRepository } from "../common/db/message-repository";
import { IpcServer } from "../common/ipc/server";
import { IpcClient } from "../common/ipc/client";

const TEST_P2_PORT = 3199;
const TEST_P1_PORT = 3198;
const TEST_P3_PORT = 3197;

// ─── Mock AffinityCache for tests that don't need DB ──

function createMockAffinityCache(): AffinityCache {
  // Use a real cache with a minimal fake — just for unit tests
  return {
    getEffective: (userId: number) => 50,
    getState: (userId: number) => "50",
    addDelta: (userId: number, delta: "+1" | "-1") => 50,
  } as unknown as AffinityCache;
}

async function main(): Promise<void> {
  console.log("=== P2 Conversation Manager 模块测试 ===\n");

  // ─── 1. Affinity Types ───────────────────────────
  console.log("[1/8] Affinity Types 测试...");

  // clampAffinity
  console.assert(clampAffinity(0) === 1, "clamp 0 → 1");
  console.assert(clampAffinity(50) === 50, "clamp 50 → 50");
  console.assert(clampAffinity(101) === 100, "clamp 101 → 100");
  console.assert(clampAffinity(-5) === 1, "clamp -5 → 1");
  console.log("  ✓ clampAffinity");

  // parseAffinity
  const p1 = parseAffinity("50");
  console.assert(p1.longTerm === 50 && p1.shortTerms.length === 0, "parse '50'");

  const p2 = parseAffinity("50+1+1");
  console.assert(p2.longTerm === 50 && p2.shortTerms.length === 2
    && p2.shortTerms[0] === "+1" && p2.shortTerms[1] === "+1", "parse '50+1+1'");

  const p3 = parseAffinity("40+1-1");
  console.assert(p3.longTerm === 40 && p3.shortTerms.length === 2
    && p3.shortTerms[0] === "+1" && p3.shortTerms[1] === "-1", "parse '40+1-1'");

  const p4 = parseAffinity("invalid");
  console.assert(p4.longTerm === 30 && p4.shortTerms.length === 0, "parse invalid → default");
  console.log("  ✓ parseAffinity");

  // formatAffinity
  console.assert(formatAffinity(50, ["+1", "+1"]) === "50+1+1", "format 50+1+1");
  console.assert(formatAffinity(40, []) === "40", "format 40");
  console.log("  ✓ formatAffinity");

  // effectiveAffinity
  console.assert(effectiveAffinity("50") === 50, "eff '50' = 50");
  console.assert(effectiveAffinity("50+1+1") === 52, "eff '50+1+1' = 52");
  console.assert(effectiveAffinity("50-1") === 49, "eff '50-1' = 49");
  console.assert(effectiveAffinity("99+1+1") === 100, "eff capped at 100");
  console.assert(effectiveAffinity("1-1") === 1, "eff floored at 1");
  console.log("  ✓ effectiveAffinity");

  // ─── 2. AffinityCache 状态机 ──────────────────────
  console.log("\n[2/8] AffinityCache 状态机测试...");
  const appConfig = loadConfig();
  const pool = createPool(appConfig.db);
  const cache = new AffinityCache(pool);

  // init from DB
  await cache.init();
  console.log("  ✓ init from DB");

  // default state
  console.assert(cache.getState(999999) === "30", "default user state = 30");
  console.assert(cache.getEffective(999999) === 30, "default effective = 30");
  console.log("  ✓ default state");

  // addDelta: basic
  const eff1 = cache.addDelta(999999, "+1");
  console.log(`  +1 → effective=${eff1}, state=${cache.getState(999999)}`);
  console.assert(eff1 === 31, "+1 → 31");

  // addDelta: cancel pair
  cache.addDelta(999999, "-1");
  const stateAfterCancel = cache.getState(999999);
  console.log(`  +1-1 → state=${stateAfterCancel} (相邻抵消)`);
  console.assert(stateAfterCancel === "30", "+1-1 应抵消回 30");

  // addDelta: merge 3 same
  cache.addDelta(999999, "+1");
  cache.addDelta(999999, "+1");
  const eff3 = cache.addDelta(999999, "+1");
  const stateAfterMerge = cache.getState(999999);
  console.log(`  +1+1+1 → effective=${eff3}, state=${stateAfterMerge} (三连并)`);
  console.assert(stateAfterMerge.startsWith("31"), "三连 +1 应并入长期好感度");
  // 但注意：先抵消再合并，我们之前有+10-10已经抵消了，现在又+10+10+10
  // 实际上第一次addDelta +1 → state=30+1, 然后addDelta -1 → state=30 (抵消)
  // 然后三次+1: 30+1, 30+1+1, 30+1+1+1 → 合并三连 → 31
  // 所以 effective 应该是 31
  console.assert(cache.getEffective(999999) === 31, "三连并 effective=31");

  // Cleanup test user
  await cache.addDelta(999999, "-1"); // reset

  // ─── 3. AffinityInjector ─────────────────────────
  console.log("\n[3/8] AffinityInjector 测试...");
  const mockCache = createMockAffinityCache();
  const injector = new AffinityInjector(cache);

  const userEntry: ContextEntry = {
    sender_name: "测试用户",
    user_id: 12345,
    message_id: 10001,
    text: "赫萝~你好",
    time: Math.floor(Date.now() / 1000),
    role: "user",
  };
  const botEntry: ContextEntry = {
    sender_name: "bot",
    user_id: 1000000000,
    message_id: 10002,
    text: "你好呀~",
    time: Math.floor(Date.now() / 1000),
    role: "assistant",
  };

  console.log(`  user inject: ${injector.inject(userEntry)}`);
  console.assert(injector.inject(userEntry)?.startsWith("affinity:"), "用户消息应有好感度注入");
  console.assert(injector.inject(botEntry) === null, "bot 消息不应注入");
  console.log("  ✓ AffinityInjector");

  // ─── 4. CooldownManager ──────────────────────────
  console.log("\n[4/8] CooldownManager 测试...");
  const cooldown = new CooldownManager(500); // 500ms 冷却（测试用短值）

  let fireCount = 0;
  const onFire = async (gid: number, _entry: CooldownTriggerEntry) => {
    fireCount++;
    console.log(`    [fire] group=${gid}, count=${fireCount}`);
  };

  // 首次触发：应立即 fire
  await cooldown.onTrigger(1000000001, { messageId: 10001 }, onFire);
  console.assert(fireCount === 1, "首次触发应立即 fire");
  const state1 = cooldown.getState(1000000001);
  console.assert(state1?.isCooling === true, "应进入冷却");
  console.log("  ✓ 首次触发立即 fire + 进入冷却");

  // 冷却中的触发：应缓存
  await cooldown.onTrigger(1000000001, { messageId: 10002 }, onFire);
  console.assert(fireCount === 1, "冷却中不 fire");
  console.assert(state1?.msgCache.length === 1, "应缓存 1 条消息");
  console.log("  ✓ 冷却中缓存");

  await cooldown.onTrigger(1000000001, { messageId: 10003 }, onFire);
  console.assert(state1?.msgCache.length === 2, "应缓存 2 条消息");
  console.log("  ✓ 继续缓存");

  // 等待冷却到期 + flush
  await new Promise((r) => setTimeout(r, 600));
  console.log(`  CD 到期后 fireCount=${fireCount}`);
  console.assert(fireCount === 2, "CD 到期应 flush 一次");
  console.assert((cooldown.getState(1000000001)?.msgCache?.length ?? 0) === 0, "msgCache 应清空");

  cooldown.destroy();

  // ─── 5. PostProcessor ────────────────────────────
  console.log("\n[5/8] PostProcessor 测试...");

  // 动作描述 + 情感匹配
  const pp = createDecomposePostProcessor();
  const r1 = pp("（赫萝开心地翘起尾巴）\n今天天气真好呀~\nhttp://127.0.0.1:5141/memesluna/holo?q=开心");
  console.log(`  动作: ${r1.params.action}, 情感: ${r1.params.emotion}, meme: ${r1.params.hasMeme}, sendMethod: ${r1.sendMethod}`);
  console.assert(r1.params.action === "赫萝开心地翘起尾巴", "应提取动作描述");
  console.assert(r1.params.emotion === "满足", "应匹配满足（开心）");
  console.assert(r1.params.hasMeme === true, "应有 meme URL");

  // 无动作描述
  const r2 = pp("你好呀~有什么可以帮你的吗？");
  console.log(`  无动作: emotion=${r2.params.emotion}, sendMethod=${r2.sendMethod}`);
  console.assert(r2.params.action === "", "无动作描述时为空");
  console.assert(r2.sendMethod === "normal", "短文本应 normal");

  // 长文本 → forward
  const longText = "A".repeat(200);
  const r3 = pp(longText);
  console.log(`  长文本(${longText.length}字符): sendMethod=${r3.sendMethod}`);
  console.assert(r3.sendMethod === "forward", "长文本应 forward");

  // Noop
  const noop = createNoopPostProcessor();
  const r4 = noop("hello");
  console.assert(r4.text === "hello" && r4.sendMethod === "normal", "noop 原样返回");
  console.log("  ✓ PostProcessor");

  // ─── 6. SilentToolExecutor ───────────────────────
  console.log("\n[6/8] SilentToolExecutor 测试...");
  const st = new SilentToolExecutor(cache);

  // get_meme: valid tag
  const memeResult = st.executeAll([
    { name: "get_meme", arguments: { tag: "开心" } },
  ]);
  console.log(`  get_meme(开心): url=${memeResult.memeUrl?.slice(0, 50)}...`);
  console.assert(memeResult.memeUrl?.includes("memesluna/holo?q="), "应返回 meme URL");
  console.log("  ✓ get_meme 有效标签");

  // get_meme: invalid tag
  const badMeme = st.executeAll([
    { name: "get_meme", arguments: { tag: "invalid_tag" } },
  ]);
  console.log(`  get_meme(invalid): error=${badMeme.error}`);
  console.assert(badMeme.error?.includes("无效的表情标签"), "非法标签应报错");
  console.log("  ✓ get_meme 无效标签");

  // update_affinity
  const testUserId = 88888;
  // Reset to 50
  cache.addDelta(testUserId, cache.getEffective(testUserId) > 30 ? "-1" : "+1");
  // Set up: get current effective
  const currentEff = cache.getEffective(testUserId);
  // Try to set to 50 baseline
  if (currentEff > 30) {
    for (let i = 0; i < (currentEff - 30); i++) cache.addDelta(testUserId, "-1");
  } else if (currentEff < 30) {
    for (let i = 0; i < (30 - currentEff); i++) cache.addDelta(testUserId, "+1");
  }

  const affResult = st.executeAll([
    { name: "update_affinity", arguments: { user_id: testUserId, delta: 1 } },
  ]);
  const newEff = cache.getEffective(testUserId);
  console.log(`  update_affinity(${testUserId}, +1): effective=${newEff}, error=${affResult.error ?? "无"}`);
  console.assert(newEff === 31, "+1 后 effective 应为 31");
  console.assert(!affResult.error, "应无错误");
  console.log("  ✓ update_affinity");

  // unknown tool
  const unknownResult = st.executeAll([
    { name: "unknown_tool", arguments: {} },
  ]);
  console.log(`  unknown_tool: error=${unknownResult.error}`);
  console.assert(unknownResult.error?.includes("未知的静默工具"), "未知工具应报错");
  console.log("  ✓ 未知工具报错");

  // ─── 7. DB 消息写入 + 查询 ────────────────────────
  console.log("\n[7/8] DB 上下文查询测试...");
  const repo = new MessageRepository(pool);

  // 写入多条测试消息（模拟对话历史）
  await repo.insertOrReplace({
    message_id: 77701, group_id: 1000000001, user_id: 12345,
    sender_name: "用户A", is_private: false, role: "user",
    content: "[MsgID:77701] [用户A](12345): 赫萝~你好",
  });
  await repo.insertOrReplace({
    message_id: 77702, group_id: 1000000001, user_id: 1000000000,
    sender_name: "bot", is_private: false, role: "assistant",
    content: "你好呀~有什么可以帮你的？",
  });
  await repo.insertOrReplace({
    message_id: 77703, group_id: 1000000001, user_id: 12345,
    sender_name: "用户A", is_private: false, role: "user",
    content: "今天天气怎么样？",
  });

  const recent = await repo.findRecentByGroup(1000000001, 5);
  console.log(`  最近 ${recent.length} 条消息`);
  console.assert(recent.length >= 3, "应查到至少 3 条");

  // 按 message_id 查找
  const found = await repo.findByMessageId(77701);
  console.assert(found?.content?.includes("赫萝~你好"), "应查到用户消息");
  console.log("  ✓ DB 上下文查询");

  // 清理
  await pool.query("DELETE FROM chat_messages WHERE message_id IN (77701, 77702, 77703)");
  // 清理 affinity 测试数据
  await pool.query("DELETE FROM user_affinity WHERE user_id IN (999999, 88888)");

  // ─── 8. IPC 通信 ──────────────────────────────────
  console.log("\n[8/8] IPC 通信测试...");
  const ipcServer = new IpcServer(TEST_P2_PORT, "P2-TEST");

  let triggerReceived: TriggerData | null = null;
  let chatResponseReceived: ChatResponseData | null = null;
  let intermediateReceived: IntermediateData | null = null;

  interface TriggerData { group_id: number; message_id: number; }
  interface ChatResponseData { group_id: number; content: string; silent_tool_calls?: unknown[]; }
  interface IntermediateData { group_id: number; content: string; }

  ipcServer.on("trigger", (payload, reply) => {
    triggerReceived = payload as TriggerData;
    console.log(`  Server 收到 trigger: group=${triggerReceived.group_id}, msg=${triggerReceived.message_id}`);
    reply({ ack: true });
  });

  ipcServer.on("chat_response", (payload, reply) => {
    chatResponseReceived = payload as ChatResponseData;
    console.log(`  Server 收到 chat_response: contentLen=${chatResponseReceived.content.length}, tools=${chatResponseReceived.silent_tool_calls?.length ?? 0}`);
    reply({ ack: true });
  });

  ipcServer.on("intermediate_reply", (payload, reply) => {
    intermediateReceived = payload as IntermediateData;
    console.log(`  Server 收到 intermediate_reply: contentLen=${intermediateReceived.content.length}`);
    reply({ ack: true });
  });

  ipcServer.on("ping", (_p, reply) => reply(null));
  await ipcServer.start();
  console.log("  ✓ IPC Server 启动");

  const client = new IpcClient(TEST_P2_PORT, "P2-TEST-CLI");
  await client.connect();
  console.log("  ✓ IPC Client 连接");

  // test trigger
  const ack1 = await client.request("trigger", { group_id: 1000000001, message_id: 10001 }, 5000);
  console.log(`  ✓ trigger 响应: ${JSON.stringify(ack1)}`);
  console.assert(triggerReceived!.group_id === 1000000001, "应收到 trigger");

  // test chat_response
  const ack2 = await client.request("chat_response", {
    group_id: 1000000001,
    message_id: 10001,
    content: "（赫萝开心地笑）\n今天天气不错呢~",
    silent_tool_calls: [{ name: "get_meme", arguments: { tag: "开心" } }],
  }, 5000);
  console.log(`  ✓ chat_response 响应: ${JSON.stringify(ack2)}`);
  console.assert(chatResponseReceived!.silent_tool_calls?.length === 1, "应收到静默工具");

  // test intermediate_reply
  const ack3 = await client.request("intermediate_reply", {
    group_id: 1000000001,
    message_id: 10001,
    content: "让我想想...",
  }, 5000);
  console.log(`  ✓ intermediate_reply 响应: ${JSON.stringify(ack3)}`);
  console.assert(intermediateReceived!.content === "让我想想...", "应收到中间回复");

  // Cleanup
  await client.disconnect();
  await ipcServer.stop();
  await pool.end();

  console.log("\n=== P2 测试全部通过 ===");
}

main().catch((err) => {
  console.error("P2 测试失败:", err);
  process.exit(1);
});
