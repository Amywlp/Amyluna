/**
 * P1 WS 客户端 — 维护 SnowLuma WebSocket 连接。
 * 从 v1 SnowLumaClient 迁移，适配三进程架构。
 *
 * 职责: 连接/心跳/指数退避重连、消息分发、action 响应匹配。
 */

import { WebSocket } from "ws";
import type { SnowLumaConfig } from "../common/config";
import type { GroupMessageEvent } from "../common/types/onebot";
import { createLogger } from "../common/logger";

const log = createLogger("P1.ws");

export interface WsClientOptions extends SnowLumaConfig {
  onGroupMessage: (event: GroupMessageEvent) => void | Promise<void>;
}

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class WsClient {
  private ws?: WebSocket;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private nextEcho = 1;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: WsClientOptions) {}

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.closedByUser = false;
    const url = new URL(this.options.wsUrl);
    if (this.options.accessToken) {
      url.searchParams.set("access_token", this.options.accessToken);
    }

    const ws = new WebSocket(url.toString());
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const onOpen = () => {
        settled = true;
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        log.info("connect.done", { attempt: this.reconnectAttempt + 1 });
        resolve();
      };

      const onError = (error: Error) => {
        log.error("connect.error", { error: error.message });
        if (!settled) { settled = true; reject(error); }
      };

      ws.once("open", onOpen);
      ws.on("error", onError);
      ws.on("message", (data) => { this.handleMessage(data.toString()); });
      ws.on("close", () => {
        if (!settled) { settled = true; reject(new Error("WebSocket closed before open")); }
        this.handleClose();
      });
    });
  }

  async request<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    const echo = `p1-${this.nextEcho++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`Action timed out: ${action}`));
      }, 30000);

      this.pending.set(echo, { resolve: (data) => resolve(data as T), reject, timer });
      ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  disconnect(): Promise<void> {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined; }

    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      ws.once("close", () => resolve());
      ws.close();
    });
  }

  private handleMessage(raw: string): void {
    log.debug("ws.recv", { len: raw.length });

    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { log.warn("ws.recv.nonjson", { len: raw.length }); return; }

    const message = parsed as Record<string, unknown>;
    if (typeof message.echo === "string") {
      const pending = this.pending.get(message.echo);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.echo);
        if (message.status === "ok" && message.retcode === 0) {
          log.info("action.done", { echo: message.echo });
          pending.resolve(message.data);
        } else {
          log.error("action.fail", { echo: message.echo, status: message.status, retcode: message.retcode });
          pending.reject(new Error(`Action failed: ${JSON.stringify(message)}`));
        }
        return;
      }
    }

    if (message.post_type === "message" && message.message_type === "group") {
      const groupEvent = message as unknown as GroupMessageEvent;
      log.info("event.groupMessage", {
        group_id: groupEvent.group_id,
        user_id: groupEvent.user_id,
        message_id: groupEvent.message_id,
      });
      void Promise.resolve(this.options.onGroupMessage(groupEvent)).catch((error) => {
        log.error("handler.groupMessage", { error: String(error) });
      });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.ping();
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  }

  private handleClose(): void {
    this.stopHeartbeat();
    this.rejectAllPending();
    if (this.closedByUser) return;

    const delay = Math.min(
      this.options.reconnectBaseDelayMs * 2 ** this.reconnectAttempt,
      this.options.reconnectMaxDelayMs,
    );
    this.reconnectAttempt += 1;
    log.warn("connect.closed", { reconnectAttempt: this.reconnectAttempt, delayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        log.warn("connect.retryFail", { error: String(err) });
        // handleClose 会在 WebSocket close 事件中再次触发重连
      });
    }, delay);
  }

  private rejectAllPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebSocket closed before response"));
    }
    this.pending.clear();
  }
}
