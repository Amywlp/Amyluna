/**
 * TCP IPC Server — JSON 行协议（\n 分隔），支持 request_id 匹配。
 *
 * 用法:
 *   const server = new IpcServer(3102, "P2");
 *   server.on("trigger", (payload, reply) => { ... });
 *   await server.start();
 */

import * as net from "node:net";
import { createLogger } from "../logger";
import type { IpcMessage, IpcType } from "../types/ipc";

type MessageHandler = (
  payload: unknown,
  reply: (payload: unknown) => void,
) => void | Promise<void>;

export class IpcServer {
  private server: net.Server | null = null;
  private handlers = new Map<IpcType, MessageHandler>();
  private log = createLogger(`IPC-S`);

  constructor(
    private readonly port: number,
    private readonly label: string,
  ) {
    this.log = createLogger(`IPC-S[${label}]`);
  }

  /** 注册消息处理器 */
  on<K extends IpcType>(type: K, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.log.info("client.connected", {
          remoteAddress: socket.remoteAddress,
        });

        let buffer = "";

        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // 不完整的最后一行保留

          for (const line of lines) {
            if (!line.trim()) continue;
            void this.handleLine(line.trim(), socket);
          }
        });

        socket.on("close", () => {
          this.log.info("client.disconnected", {
            remoteAddress: socket.remoteAddress,
          });
        });

        socket.on("error", (err) => {
          this.log.warn("socket.error", { error: err.message });
        });
      });

      this.server.on("error", (err) => {
        this.log.error("server.error", { error: err.message });
        reject(err);
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        this.log.info("listening", { port: this.port, label: this.label });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.log.info("stopped", { port: this.port });
        resolve();
      });
    });
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let msg: IpcMessage;
    try {
      msg = JSON.parse(line) as IpcMessage;
    } catch {
      this.log.warn("recv.badjson", { line: line.slice(0, 100) });
      return;
    }

    this.log.debug("recv", { type: msg.type, requestId: msg.request_id });

    const handler = this.handlers.get(msg.type);
    if (!handler) {
      this.log.warn("recv.no_handler", { type: msg.type });
      return;
    }

    try {
      await handler(msg.payload, (replyPayload) => {
        if (msg.request_id) {
          const reply: IpcMessage = {
            type: msg.type,
            payload: replyPayload,
            request_id: msg.request_id,
          };
          socket.write(JSON.stringify(reply) + "\n", "utf8");
        }
      });
    } catch (err) {
      this.log.error("handler.error", {
        type: msg.type,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
