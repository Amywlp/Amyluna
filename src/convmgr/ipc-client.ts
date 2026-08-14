/**
 * P2 IPC Client 工厂 — 创建到 P1 和 P3 的 IPC 连接。
 */
import { IpcClient } from "../common/ipc/client";
import { createLogger } from "../common/logger";

const log = createLogger("P2.ipc-cli");

export interface P2IpcClients {
  p1Client: IpcClient;
  p3Client: IpcClient;
}

export async function createP2IpcClients(p1Port: number, p3Port: number): Promise<P2IpcClients> {
  // 连接到 P3（带重试，P3 可能尚未启动）
  log.info("connecting to P3", { port: p3Port });
  const p3Client = new IpcClient(p3Port, "P2→P3");
  await p3Client.connectWithRetry(30, 1000);
  log.info("p3 connected");

  // 连接到 P1（带重试，P1 可能尚未启动）
  log.info("connecting to P1", { port: p1Port });
  const p1Client = new IpcClient(p1Port, "P2→P1");
  await p1Client.connectWithRetry(30, 1000);
  log.info("p1 connected");

  return { p1Client, p3Client };
}
