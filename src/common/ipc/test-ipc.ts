/**
 * IPC 通信测试脚本。
 * 创建 server 和 client，验证 ping/pong、request-response 和 send-only 模式。
 *
 * 用法:
 *   npx tsx src/common/ipc/test-ipc.ts
 */

import { IpcServer } from "./server";
import { IpcClient } from "./client";

const TEST_PORT = 3199;

async function main(): Promise<void> {
  console.log("=== IPC 通信测试 ===\n");

  // 1. 启动 server
  console.log("[1/5] 启动 IPC Server...");
  const server = new IpcServer(TEST_PORT, "TEST");
  server.on("ping", (_payload, reply) => {
    reply({ echo: "pong" });
  });
  server.on("echo", (payload, reply) => {
    console.log(`  Server 收到 echo: ${JSON.stringify(payload)}`);
    reply({ received: payload, ts: Date.now() });
  });
  server.on("notify", (payload) => {
    console.log(`  Server 收到 notify: ${JSON.stringify(payload)}`);
  });
  await server.start();
  console.log("  ✓ Server 已启动");

  // 2. client 连接
  console.log("\n[2/5] Client 连接...");
  const client = new IpcClient(TEST_PORT, "TEST-CLIENT");
  await client.connect();
  console.log("  ✓ Client 已连接");

  // 3. ping/pong
  console.log("\n[3/5] Ping/Pong 测试...");
  const pongResult = await client.request("ping", null as never, 5000);
  console.log(`  ✓ ping 响应: ${JSON.stringify(pongResult)}`);

  // 4. echo (request-response)
  console.log("\n[4/5] Request-Response 测试...");
  const echoResult = await client.request("echo", { message: "hello amyluna", n: 42 }, 5000);
  console.log(`  ✓ echo 响应: ${JSON.stringify(echoResult)}`);

  // 5. send-only
  console.log("\n[5/5] Send-only 测试...");
  client.send("notify", { event: "test", value: 123 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log("  ✓ notify 已发送");

  // 清理
  await client.disconnect();
  await server.stop();
  console.log("\n=== IPC 测试全部通过 ===");
}

main().catch((err) => {
  console.error("IPC 测试失败:", err);
  process.exit(1);
});
