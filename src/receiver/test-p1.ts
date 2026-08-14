/**
 * P1 Receiver 模块测试。
 *
 * 用法:
 *   npx tsx src/receiver/test-p1.ts
 */

import { isTriggered, type GroupTriggerState } from "./trigger";
import type { GroupMessageEvent, MessageSegment } from "../common/types/onebot";
import { extractTextWithoutAt, extractImageUrls, extractQuotedMessageId, hasAtBot } from "../common/text";
import { IpcServer } from "../common/ipc/server";
import { IpcClient } from "../common/ipc/client";
import { loadConfig } from "../common/config";
import { createPool } from "../common/db/pool";
import { MessageRepository } from "../common/db/message-repository";

const TEST_PORT = 3198;

// ─── 辅助: 创建 mock 群消息事件 ────────────────────────
function makeEvent(overrides: Partial<GroupMessageEvent> = {}): GroupMessageEvent {
  return {
    post_type: "message",
    message_type: "group",
    message_id: 10001,
    group_id: 1000000001,
    user_id: 12345,
    self_id: 1000000000,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: "text", data: { text: "赫萝~你好" } }],
    raw_message: "赫萝~你好",
    sender: { user_id: 12345, nickname: "测试用户" },
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("=== P1 Receiver 模块测试 ===\n");

  // ─── 1. Trigger 判断逻辑 ──────────────────────────────
  console.log("[1/6] Trigger 判断测试...");
  const config = {
    botId: 1000000000,
    triggerKeywords: ["赫萝~"],
    prdC: 0.0038,
  };
  const botMsgIds = new Set<number>();
  const noReply = () => false;
  const isReplyToBot = (id: number) => botMsgIds.has(id);

  // 关键词触发
  const state1: GroupTriggerState = { prdP: 0 };
  const r1 = isTriggered(makeEvent(), "赫萝~你好", config, state1, noReply);
  console.log(`  ✓ 关键词触发: triggered=${r1.triggered}, reason=${r1.reason}`);
  console.assert(r1.triggered && r1.reason === "keyword", "关键词应触发");

  // AT 触发
  const state2: GroupTriggerState = { prdP: 0 };
  const r2 = isTriggered(
    makeEvent({
      message: [
        { type: "at", data: { qq: "1000000000" } },
        { type: "text", data: { text: "在吗" } },
      ],
      raw_message: "[CQ:at,qq=1000000000] 在吗",
    }),
    "在吗", config, state2, noReply,
  );
  console.log(`  ✓ AT 触发: triggered=${r2.triggered}, reason=${r2.reason}`);
  console.assert(r2.triggered && r2.reason === "at", "AT 应触发");

  // Reply 触发
  botMsgIds.add(99901);
  const state3: GroupTriggerState = { prdP: 0 };
  const r3 = isTriggered(
    makeEvent({
      message: [
        { type: "reply", data: { id: "99901" } },
        { type: "text", data: { text: "说得好" } },
      ],
    }),
    "说得好", config, state3, isReplyToBot,
  );
  console.log(`  ✓ Reply 触发: triggered=${r3.triggered}, reason=${r3.reason}`);
  console.assert(r3.triggered && r3.reason === "reply", "Reply 应触发");

  // PRD 触发（高概率确保触发）
  const state4: GroupTriggerState = { prdP: 0.999 };
  const r4 = isTriggered(makeEvent({ message: [{ type: "text", data: { text: "随便说说" } }] }), "随便说说", config, state4, noReply);
  console.log(`  ✓ PRD 触发: triggered=${r4.triggered}, reason=${r4.reason}`);
  console.assert(r4.triggered && r4.reason === "prd", "PRD 应触发");

  // 不触发
  const state5: GroupTriggerState = { prdP: 0 };
  const r5 = isTriggered(makeEvent({ message: [{ type: "text", data: { text: "路过" } }] }), "路过", config, state5, noReply);
  console.log(`  ✓ 不触发: triggered=${r5.triggered}`);
  console.assert(!r5.triggered, "不应触发");

  // PRD 累积
  const state6: GroupTriggerState = { prdP: 0 };
  isTriggered(makeEvent({ message: [{ type: "text", data: { text: "a" } }] }), "a", config, state6, noReply);
  console.log(`  ✓ PRD 累积后: prdP=${state6.prdP.toFixed(6)} (原 C=0.0038)`);
  console.assert(state6.prdP >= config.prdC, "PRD 应累积");

  // ─── 2. 文本提取 ──────────────────────────────────────
  console.log("\n[2/6] 文本提取测试...");
  const segsWithAt: MessageSegment[] = [
    { type: "at", data: { qq: "1000000000" } },
    { type: "text", data: { text: "赫萝~帮我查个东西" } },
  ];
  const clean = extractTextWithoutAt(segsWithAt, 1000000000);
  console.log(`  ✓ extractTextWithoutAt: "${clean}"`);
  console.assert(clean === "赫萝~帮我查个东西", "应去除 AT");

  const segsWithReply: MessageSegment[] = [
    { type: "reply", data: { message_id: "99901" } },
    { type: "text", data: { text: "好" } },
  ];
  const qid = extractQuotedMessageId(segsWithReply);
  console.log(`  ✓ extractQuotedMessageId: ${qid}`);
  console.assert(qid === "99901", "应提取 reply id");

  // ─── 3. hasAtBot ──────────────────────────────────────
  console.log("\n[3/6] hasAtBot 测试...");
  const atResult = hasAtBot(segsWithAt, 1000000000);
  console.log(`  ✓ hasAtBot: ${atResult}`);
  console.assert(atResult, "应检测到 AT");

  const noAtResult = hasAtBot(
    [{ type: "text", data: { text: "hello" } }],
    1000000000,
  );
  console.log(`  ✓ hasAtBot (无 AT): ${noAtResult}`);
  console.assert(!noAtResult, "不应检测到 AT");

  // ─── 4. extractImageUrls ──────────────────────────────
  console.log("\n[4/6] extractImageUrls 测试...");
  const imgSegs: MessageSegment[] = [
    { type: "image", data: { url: "http://example.com/img.jpg", file: "img.jpg" } },
    { type: "text", data: { text: "看这张图" } },
  ];
  const urls = extractImageUrls(imgSegs);
  console.log(`  ✓ extractImageUrls: ${urls.length} 个 URL: ${urls.join(", ")}`);
  console.assert(urls.length === 1, "应提取 1 个图片 URL");

  // ─── 5. DB 连接 + 消息写入 ────────────────────────────
  console.log("\n[5/6] DB 消息写入测试...");
  const appConfig = loadConfig();
  const pool = createPool(appConfig.db);
  const repo = new MessageRepository(pool);

  const inserted = await repo.insertOrReplace({
    message_id: 88801,
    group_id: 1000000001,
    user_id: 12345,
    sender_name: "P1测试用户",
    is_private: false,
    role: "user",
    content: "P1 测试消息: 赫萝~hello",
    image_urls: JSON.stringify(["http://example.com/test.jpg"]),
    media_parsed: 1,
    quoted_message_id: null,
  });
  console.log(`  ✓ 插入: id=${inserted.id}, message_id=${inserted.message_id}`);

  const found = await repo.findByMessageId(88801);
  console.log(`  ✓ 查找: content="${found?.content}", images=${found?.image_urls}`);
  console.assert(found?.content?.includes("P1 测试消息"), "内容应正确");

  // 清理
  await pool.query("DELETE FROM chat_messages WHERE message_id = ?", [88801]);
  await pool.end();

  // ─── 6. IPC 通信 ──────────────────────────────────────
  console.log("\n[6/6] IPC 通信测试...");
  const server = new IpcServer(TEST_PORT, "P1-TEST");
  server.on("trigger", (payload, reply) => {
    const p = payload as { group_id: number; message_id: number };
    console.log(`  Server 收到 trigger: group=${p.group_id}, msg=${p.message_id}`);
    reply({ ack: true });
  });
  server.on("ping", (_p, reply) => reply(null));
  await server.start();
  console.log("  ✓ IPC Server 启动");

  const client = new IpcClient(TEST_PORT, "P1-TEST-CLI");
  await client.connect();
  console.log("  ✓ IPC Client 连接");

  const ack = await client.request("trigger", { group_id: 1000000001, message_id: 10001 }, 5000);
  console.log(`  ✓ trigger 响应: ${JSON.stringify(ack)}`);

  await client.disconnect();
  await server.stop();

  console.log("\n=== P1 测试全部通过 ===");
}

main().catch((err) => {
  console.error("P1 测试失败:", err);
  process.exit(1);
});
