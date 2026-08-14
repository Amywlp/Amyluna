/**
 * TCP IPC Client — JSON 行协议，支持 request-response。
 *
 * 用法:
 *   const client = new IpcClient(3102, "P2-client");
 *   await client.connect();
 *   client.send("chat", { context, preset, group_id, message_id });
 *   const reply = await client.request("chat", { ... }, 30000);
 */

import * as net from "node:net";
import { createLogger } from "../logger";
import type { IpcMessage, IpcType, IpcPayloadMap } from "../types/ipc";

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, PendingRequest>();
  private log = createLogger(`IPC-C`);

  constructor(
    private readonly port: number,
    private readonly label: string,
  ) {
    this.log = createLogger(`IPC-C[${label}]`);
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;

    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ port: this.port, host: "127.0.0.1" }, () => {
        this.log.info("connected", { port: this.port });
        resolve();
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleLine(line.trim());
        }
      });

      this.socket.on("close", () => {
        this.log.warn("disconnected", { port: this.port });
        this.rejectAllPending(new Error(`IPC disconnected (port ${this.port})`));
      });

      this.socket.on("error", (err) => {
        this.log.error("socket.error", { error: err.message });
        reject(err);
      });
    });
  }

  /**
   * 带重试的连接：每隔 retryIntervalMs 重试一次，最多重试 maxRetries 次。
   * 用于启动时目标进程可能尚未就绪的场景。
   */
  async connectWithRetry(maxRetries = 30, retryIntervalMs = 1000): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.connect();
        return;
      } catch (err) {
        const remaining = maxRetries - i - 1;
        if (remaining <= 0) {
          throw new Error(
            `IPC connect to port ${this.port} failed after ${maxRetries} retries: ${String(err)}`,
          );
        }
        this.log.warn("connect.retry", {
          port: this.port,
          attempt: i + 1,
          remaining,
          error: String(err),
        });
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }
  }

  /**
   * 持久连接：无限重试，断开自动重连。永不抛出，永远在后台运行。
   *
   * 用于三进程间解耦 —— 一方未就绪不影响另一方继续运行。
   * 连接失败/断开时写入 "service.unavailable" 日志。
   *
   * @param label 对端进程标识（如 "P1"/"P2"/"P3"），用于日志
   */
  connectPersistent(label: string): void {
    const BACKOFF_BASE = 1000;
    const BACKOFF_MAX = 30000;

    const loop = async () => {
      let delay = BACKOFF_BASE;
      while (true) {
        if (this.socket && !this.socket.destroyed) {
          // 已连接：等待断开后重连
          await new Promise<void>((resolve) => {
            this.socket!.once("close", () => resolve());
          });
          this.log.warn("peer.disconnected", { label, port: this.port });
        }

        try {
          await this.connect();
          this.log.info("peer.connected", { label, port: this.port });
          delay = BACKOFF_BASE; // 成功后重置退避

          // 等待断开
          await new Promise<void>((resolve) => {
            this.socket!.once("close", () => resolve());
          });
          this.log.warn("peer.disconnected", { label, port: this.port });
        } catch (err) {
          this.log.warn("service.unavailable", {
            label,
            port: this.port,
            error: (err as Error).message ?? String(err),
            retryInMs: delay,
            hint: `${label} 服务暂不可用，${delay / 1000}s 后重试`,
          });
        }

        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(BACKOFF_MAX, delay * 2);
      }
    };

    void loop();
  }

  /** 发送消息（不等待回复）。若未连接则静默忽略并记录警告。 */
  send<K extends IpcType>(type: K, payload: IpcPayloadMap[K]): void {
    if (!this.socket || this.socket.destroyed) {
      this.log.warn("send.skipped", { type, reason: "not connected" });
      return;
    }
    const msg: IpcMessage = { type, payload };
    this.log.debug("send", { type });
    this.socket.write(JSON.stringify(msg) + "\n", "utf8");
  }

  /** 发送消息（必须已连接，否则抛出）。用于需要保证送达的场景。 */
  sendOrThrow<K extends IpcType>(type: K, payload: IpcPayloadMap[K]): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(`IPC client (port ${this.port}) not connected`);
    }
    const msg: IpcMessage = { type, payload };
    this.log.debug("send", { type });
    this.socket.write(JSON.stringify(msg) + "\n", "utf8");
  }

  /** 发送消息并等待回复（request-response） */
  async request<K extends IpcType>(
    type: K,
    payload: IpcPayloadMap[K],
    timeoutMs: number = 30000,
  ): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error(`IPC client (port ${this.port}) not connected`);
    }

    const requestId = `ipc-${this.nextId++}`;
    const msg: IpcMessage = { type, payload, request_id: requestId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`IPC request timed out: ${type} (${requestId})`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      this.log.debug("request", { type, requestId });
      this.socket!.write(JSON.stringify(msg) + "\n", "utf8");
    });
  }

  async disconnect(): Promise<void> {
    this.rejectAllPending(new Error("IPC client disconnected"));
    if (!this.socket) return;
    return new Promise((resolve) => {
      this.socket!.once("close", () => resolve());
      this.socket!.destroy();
      this.socket = null;
    });
  }

  private handleLine(line: string): void {
    let msg: IpcMessage;
    try {
      msg = JSON.parse(line) as IpcMessage;
    } catch {
      this.log.warn("recv.badjson", { line: line.slice(0, 100) });
      return;
    }

    if (msg.request_id) {
      const pending = this.pending.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.request_id);
        this.log.debug("response", { type: msg.type, requestId: msg.request_id });
        pending.resolve(msg.payload);
        return;
      }
    }

    this.log.debug("recv", { type: msg.type });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
