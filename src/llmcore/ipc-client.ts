/**
 * P3 IPC Client 工厂 — 创建到 P1 和 P2 的 IPC 连接。
 */

import { IpcClient } from "../common/ipc/client";
import { createLogger } from "../common/logger";

const log = createLogger("P3.ipc-cli");

export interface P3IpcClients {
  p1Client: IpcClient;
  p2Client: IpcClient;
}

export async function createP3IpcClients(p1Port: number, p2Port: number): Promise<P3IpcClients> {
  const p1Client = new IpcClient(p1Port, "P3→P1");
  const p2Client = new IpcClient(p2Port, "P3→P2");

  // 连接到 P2（带重试，P2 可能尚未启动）
  log.info("connecting to P2", { port: p2Port });
  await p2Client.connectWithRetry(30, 1000);
  log.info("p2 connected");

  // 连接到 P1（带重试，P1 可能尚未启动）
  log.info("connecting to P1", { port: p1Port });
  await p1Client.connectWithRetry(30, 1000);
  log.info("p1 connected");

  return { p1Client, p2Client };
}
