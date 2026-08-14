/**
 * MCP (Model Context Protocol) client — stdio + SSE transports。
 * 从 v1 tools/mcp/client.ts 迁移，供 P3 LLM Core 使用。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { ToolRegistry } from "../registry";
import type { ToolMeta, ToolResult } from "../types";
import { createLogger } from "../../../common/logger";

// ─── config types ──────────────────────────────────────

export interface McpStdioConfig {
  type: "stdio";
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export interface McpSseConfig {
  type: "sse";
  id: string;
  url: string;
  headers?: Record<string, string>;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
}

export type McpServerConfig = McpStdioConfig | McpSseConfig;

const log = createLogger("P3.mcp");

// ─── config types ──────────────────────────────────────

// ─── JSON-RPC helpers ──────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── transport abstraction ─────────────────────────────

interface McpTransport {
  id: string;
  start(): Promise<void>;
  send(message: JsonRpcRequest | JsonRpcNotification): void;
  close(): void;
  onMessage: ((msg: JsonRpcResponse) => void) | null;
  onClose: (() => void) | null;
  onError: ((err: Error) => void) | null;
}

// ─── stdio transport ───────────────────────────────────

class StdioTransport implements McpTransport {
  private proc?: ChildProcess;
  private buffer = "";

  onMessage: ((msg: JsonRpcResponse) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor(
    public readonly id: string,
    private readonly config: McpStdioConfig,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.config.env };
      const child = spawn(this.config.command, this.config.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: false,
      });
      this.proc = child;

      const timer = setTimeout(() => {
        reject(new Error(`MCP stdio server "${this.id}" startup timed out after ${this.config.startupTimeoutMs}ms`));
        child.kill();
      }, this.config.startupTimeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        this.onError?.(err);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        log.warn("stdio.closed", { id: this.id, code });
        this.onClose?.();
      });

      child.stderr?.on("data", (data: Buffer) => {
        log.warn("stdio.stderr", { id: this.id, text: data.toString().trim().slice(0, 500) });
      });

      child.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JsonRpcResponse;
            this.onMessage?.(msg);
          } catch {
            log.warn("stdio.badJson", { id: this.id, raw: trimmed.slice(0, 200) });
          }
        }
      });

      const graceTimer = setTimeout(() => { resolve(); }, 3000);
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        resolve();
      };
      child.stdout?.on("data", () => done());
      child.stderr?.on("data", () => done());
    });
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.proc?.stdin || this.proc.killed) {
      throw new Error(`MCP stdio server "${this.id}" is not running`);
    }
    const line = JSON.stringify(message) + "\n";
    this.proc.stdin.write(line);
  }

  close(): void {
    if (this.proc && !this.proc.killed) this.proc.kill();
  }
}

// ─── SSE transport ─────────────────────────────────────

class SseTransport implements McpTransport {
  private postUrl = "";
  private abortController?: AbortController;
  private endpointResolve?: () => void;

  onMessage: ((msg: JsonRpcResponse) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor(
    public readonly id: string,
    private readonly config: McpSseConfig,
  ) {}

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const timer = setTimeout(() => { this.abortController?.abort(); }, this.config.startupTimeoutMs);

    let endpointTimer: NodeJS.Timeout;
    const endpointReady = new Promise<void>((resolve) => {
      this.endpointResolve = resolve;
      endpointTimer = setTimeout(() => { resolve(); }, 2000);
    });

    try {
      const response = await fetch(this.config.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...this.config.headers,
        },
        signal: this.abortController.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`SSE connection failed with ${response.status}: ${body.slice(0, 300)}`);
      }
      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      log.info("sse.connected", { id: this.id });
      void this.readSseStream(response.body);
      await endpointReady;
      clearTimeout(endpointTimer!);
    } catch (err) {
      clearTimeout(timer);
      if (this.endpointResolve) { clearTimeout(endpointTimer!); this.endpointResolve(); }
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`MCP SSE server "${this.id}" startup timed out after ${this.config.startupTimeoutMs}ms`);
      }
      throw err;
    }
  }

  private async readSseStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.warn("sse.streamEnded", { id: this.id });
          this.onClose?.();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const normalised = buffer.replace(/\r\n/g, "\n");
        const parts = normalised.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          const parsed = this.parseSseEvent(part);
          if (parsed === null) continue;

          if (parsed.event === "endpoint") {
            this.postUrl = this.resolvePostUrl(parsed.data.trim());
            log.info("sse.endpoint", { id: this.id, postUrl: this.postUrl });
            this.endpointResolve?.();
            continue;
          }

          try {
            const msg = JSON.parse(parsed.data) as Record<string, unknown>;
            if (typeof msg.endpoint === "string") {
              this.postUrl = this.resolvePostUrl(msg.endpoint);
              log.info("sse.endpoint", { id: this.id, postUrl: this.postUrl });
              this.endpointResolve?.();
              continue;
            }
            if (msg.jsonrpc === "2.0" && typeof msg.id !== "undefined") {
              this.onMessage?.(msg as unknown as JsonRpcResponse);
            }
          } catch {
            log.warn("sse.badJson", { id: this.id, raw: parsed.data.slice(0, 200) });
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("sse.streamError", { id: this.id, error: error.message });
      this.onError?.(error);
    } finally {
      reader.releaseLock();
    }
  }

  private parseSseEvent(block: string): { event: string; data: string } | null {
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
    }
    if (!data && !event) return null;
    return { event, data };
  }

  private resolvePostUrl(endpoint: string): string {
    try { return new URL(endpoint, this.config.url).toString(); }
    catch { return endpoint.startsWith("/") ? new URL(endpoint, this.config.url).toString() : endpoint; }
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    const target = this.postUrl || this.config.url;
    fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.config.headers },
      body: JSON.stringify(message),
      signal: this.abortController?.signal,
    }).catch((err) => {
      log.error("sse.postError", { id: this.id, error: String(err) });
    });
  }

  close(): void { this.abortController?.abort(); }
}

// ─── connection (protocol layer) ───────────────────────

class McpConnection {
  private transport: McpTransport;
  private nextId = 1;
  private pending = new Map<number | string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private started = false;

  constructor(private readonly config: McpServerConfig) {
    this.transport = config.type === "stdio"
      ? new StdioTransport(config.id, config)
      : new SseTransport(config.id, config);

    this.transport.onMessage = (msg) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
    };

    this.transport.onError = (err) => {
      log.error("transportError", { id: config.id, error: err.message });
    };
  }

  async connect(): Promise<void> {
    if (this.started) return;
    await this.transport.start();

    const initResult = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "amyluna-p3", version: "0.1.0" },
    });
    log.info("initialized", { id: this.config.id, serverInfo: JSON.stringify(initResult).slice(0, 300) });

    this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.started = true;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: McpTool[] }).tools ?? [];
    log.info("tools", { id: this.config.id, count: tools.length });
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    const res = result as McpToolResult;
    const contents = res.content ?? [];
    const text = contents
      .filter((c: McpContent) => c.type === "text")
      .map((c: McpContent) => c.text)
      .join("\n");
    if (res.isError) return { error: text || "MCP tool returned an error" };
    return { content: text || JSON.stringify(res) };
  }

  close(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("MCP connection closed"));
    }
    this.pending.clear();
    this.transport.close();
    this.started = false;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = `${this.config.id}-${this.nextId++}`;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out for server "${this.config.id}"`));
      }, this.config.toolTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send(msg);
    });
  }
}

// ─── MCP tool schema types ─────────────────────────────

interface McpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
}

interface McpToolResult {
  content?: McpContent[];
  isError?: boolean;
}

// ─── connect single server ─────────────────────────────

async function connectMcpServer(
  config: McpServerConfig,
  registry: ToolRegistry,
): Promise<void> {
  log.info("connect.start", { id: config.id, type: config.type });
  const connection = new McpConnection(config);

  try {
    await connection.connect();
  } catch (err) {
    log.error("connect.fail", { id: config.id, error: String(err) });
    connection.close();
    return;
  }

  let tools: McpTool[];
  try {
    tools = await connection.listTools();
  } catch (err) {
    log.error("listTools.fail", { id: config.id, error: String(err) });
    connection.close();
    return;
  }

  for (const tool of tools) {
    const meta: ToolMeta = {
      definition: {
        type: "function",
        function: {
          name: `${config.id}_${tool.name}`,
          description: tool.description ?? `MCP tool: ${tool.name}`,
          parameters: {
            type: tool.inputSchema.type,
            properties: tool.inputSchema.properties ?? {},
            ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
          },
        },
      },
      execute: async (args) => connection.callTool(tool.name, args),
      requiresFollowUp: true,
      timeout: config.toolTimeoutMs,
      resultMaxLength: 4000,
    };
    registry.register(meta);
  }

  log.info("connect.done", { id: config.id, toolCount: tools.length });
}

// ─── public entry point ────────────────────────────────

export async function connectMcpTools(
  registry: ToolRegistry,
  servers: McpServerConfig[],
): Promise<void> {
  if (servers.length === 0) return;
  log.info("connectAll.start", { serverCount: servers.length });
  await Promise.all(servers.map((cfg) => connectMcpServer(cfg, registry)));
  log.info("connectAll.done");
}
