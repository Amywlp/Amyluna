/**
 * P1 IPC Client 工厂 — 创建到 P2 和 P3 的 IPC 连接。
 */

import { IpcClient } from "../common/ipc/client";
import { createLogger } from "../common/logger";

const log = createLogger("P1.ipc-cli");

export interface P1IpcClients {
  p2Client: IpcClient;
  p3Client: IpcClient;
}

export async function createP1IpcClients(p2Port: number, p3Port: number): Promise<P1IpcClients> {
  const p2Client = new IpcClient(p2Port, "P1→P2");
  const p3Client = new IpcClient(p3Port, "P1→P3");

  // 连接到 P3（带重试，P3 可能尚未启动）
  log.info("connecting to P3", { port: p3Port });
  await p3Client.connectWithRetry(30, 1000);
  log.info("p3 connected");

  // 连接到 P2（带重试，P2 可能尚未启动）
  log.info("connecting to P2", { port: p2Port });
  await p2Client.connectWithRetry(30, 1000);
  log.info("p2 connected");

  return { p2Client, p3Client };
}
