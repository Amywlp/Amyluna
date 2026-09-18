/**
 * 统一配置加载模块。
 * 读取 .env 生成结构化配置，各进程按需取切片。
 * 参考 v1 config/index.ts，适配三进程架构。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";

// ─── 类型定义 ───────────────────────────────────────────

export interface SnowLumaConfig {
  wsUrl: string;
  accessToken: string;
  httpAccessToken?: string;
  heartbeatIntervalMs: number;
  reconnectBaseDelayMs: number;
  reconnectMaxDelayMs: number;
}

export interface LLMProviderConfig {
  id: string;
  aliases: string[];
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: string;
  fallback?: string;
  headers?: Record<string, string>;
}

export interface LLMRelayConfig {
  defaultAlias: string;
  providers: LLMProviderConfig[];
}

export interface McpServerConfig {
  type: "stdio" | "sse";
  id: string;
  startupTimeoutMs: number;
  toolTimeoutMs: number;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse
  url?: string;
  headers?: Record<string, string>;
}

export interface TtsConfig {
  baseUrl: string;
  voice: string;
  voiceConfigDir: string;
  outputDir: string;
  sendMode: "sequential" | "forward-audio" | "forward-video";
  apiTimeoutMs: number;
  maxRetries: number;
  maxTextLen: number;
  defaultLang: string;
  fileTtlMs: number;
}

export interface Text2ImageConfig {
  baseUrl: string;
  apiKey: string;
  promptModel: string;
  imageModel: string;
  imageSize: string;
  outputDir: string;
  promptTimeoutMs: number;
  imageTimeoutMs: number;
  maxRetries: number;
  maxTopicLen: number;
  fileTtlMs: number;
  presetPath: string;
}

export interface AppConfig {
  /** P1 Receiver 端口 */
  p1Port: number;
  /** P2 ConvMgr 端口 */
  p2Port: number;
  /** P3 LLM Core 端口 */
  p3Port: number;
  snowluma: SnowLumaConfig;
  llmRelay: LLMRelayConfig;
  chat: {
    presetName: string;
    presetDir: string;
    maxTurns: number;
    acceptImages: boolean;
    visionAlias: string;
    imagePrompt: string;
    replyMaxLength: number;
    botId: number;
    triggerKeywords: string[];
    whitelistGroupIds: number[];
    errorAlertGroupId: number;
    contextLimit: number;
    cooldownMs: number;
    replyTimeoutMs: number;
    prdC: number;
    rateLimitWindowMs: number;
    rateLimitMaxRequests: number;
  };
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolMax: number;
    poolIdleTimeoutMs: number;
  };
  mcp: {
    servers: McpServerConfig[];
  };
  silentTool: {
    /** 需要通过任务队列管理的工具类型集合（从 SILENT_TOOL_QUEUE 解析） */
    queuedTools: Set<string>;
  };
  taskQueue: {
    /** 不可并行的工具类型集合（从 TASK_QUEUE_SERIAL 解析） */
    serialTools: Set<string>;
  };
  tts: TtsConfig;
  text2image: Text2ImageConfig;
  muriAgent: {
    /** 最大工具调用轮次 */
    maxTurns: number;
    /** LLM 模型别名（可选，默认走 relay 的 defaultAlias） */
    model?: string;
  };
  watchdog: {
    intervalMs: number;
    maxFailures: number;
  };
}

// ─── 工具函数 ───────────────────────────────────────────

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveEnvFile(): string {
  const envFile = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envFile)) return envFile;
  return path.resolve(process.cwd(), ".env.example");
}

// ─── LLM Provider 解析 ──────────────────────────────────

export function loadLLMProviders(env: NodeJS.ProcessEnv): LLMProviderConfig[] {
  const json = env.LLM_PROVIDERS_JSON;
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`LLM_PROVIDERS_JSON is not valid JSON: ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new Error("LLM_PROVIDERS_JSON must be an array");
  return (raw as unknown[]).map((item, i) => {
    const obj = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(obj.id ?? `provider-${i}`),
      aliases: Array.isArray(obj.aliases) ? obj.aliases.map(String) : [],
      baseUrl: String(obj.baseUrl ?? ""),
      apiKey: String(obj.apiKey ?? ""),
      model: String(obj.model ?? ""),
      enabled: obj.enabled !== false,
      maxTokens: typeof obj.maxTokens === "number" ? obj.maxTokens : undefined,
      timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
      reasoningEffort: typeof obj.reasoningEffort === "string" ? obj.reasoningEffort : undefined,
      fallback: typeof obj.fallback === "string" ? obj.fallback : undefined,
      headers:
        typeof obj.headers === "object" && obj.headers !== null
          ? Object.fromEntries(
              Object.entries(obj.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
            )
          : undefined,
    };
  });
}

// ─── MCP Server 解析 ────────────────────────────────────

function parseMcpServers(json: string | undefined): McpServerConfig[] {
  if (!json?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`MCP_SERVERS_JSON is not valid JSON: ${String(err)}`);
  }
  if (!Array.isArray(raw)) throw new Error("MCP_SERVERS_JSON must be an array");
  return (raw as unknown[]).map((item, i) => normalizeMcpServer(item, i));
}

function normalizeMcpServer(raw: unknown, index: number): McpServerConfig {
  const item = (raw ?? {}) as Record<string, unknown>;
  const type = String(item.type ?? "stdio");
  if (type !== "stdio" && type !== "sse") {
    throw new Error(`MCP server #${index + 1}: unsupported type "${type}"`);
  }
  const id = String(item.id ?? `mcp-${index + 1}`);
  const startupTimeoutMs = Number(item.startupTimeoutMs ?? 20000) || 20000;
  const toolTimeoutMs = Number(item.toolTimeoutMs ?? 60000) || 60000;

  if (type === "stdio") {
    const args = Array.isArray(item.args) ? item.args.map(String) : [];
    const env =
      typeof item.env === "object" && item.env !== null
        ? Object.fromEntries(Object.entries(item.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : {};
    return { type: "stdio", id, command: String(item.command ?? "npx"), args, env, startupTimeoutMs, toolTimeoutMs };
  }
  // sse
  const headers =
    typeof item.headers === "object" && item.headers !== null
      ? Object.fromEntries(Object.entries(item.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : {};
  return { type: "sse", id, url: String(item.url ?? ""), headers, startupTimeoutMs, toolTimeoutMs };
}

function validateTtsSendMode(value: string | undefined): "sequential" | "forward-audio" | "forward-video" {
  if (value === "forward-audio" || value === "forward-video") return value;
  return "sequential";
}

// ─── 主加载函数 ─────────────────────────────────────────

export function loadConfig(): AppConfig {
  const envFile = resolveEnvFile();
  console.log("[config] loading from " + envFile);
  dotenv.config({ path: envFile });
  const env = process.env;

  return {
    p1Port: toPositiveInt(env.P1_PORT, 3101),
    p2Port: toPositiveInt(env.P2_PORT, 3102),
    p3Port: toPositiveInt(env.P3_PORT, 3103),
    snowluma: {
      wsUrl: env.SNOWLUMA_WS_URL || "ws://127.0.0.1:3001",
      accessToken: env.SNOWLUMA_ACCESS_TOKEN || "",
      httpAccessToken: env.SNOWLUMA_HTTP_ACCESS_TOKEN || env.SNOWLUMA_ACCESS_TOKEN || "",
      heartbeatIntervalMs: toPositiveInt(env.SNOWLUMA_HEARTBEAT_INTERVAL_MS, 30000),
      reconnectBaseDelayMs: toPositiveInt(env.SNOWLUMA_RECONNECT_BASE_DELAY_MS, 1000),
      reconnectMaxDelayMs: toPositiveInt(env.SNOWLUMA_RECONNECT_MAX_DELAY_MS, 30000),
    },
    llmRelay: {
      defaultAlias: env.LLM_RELAY_DEFAULT_ALIAS || "LLM",
      providers: loadLLMProviders(env),
    },
    chat: {
      presetName: env.PRESET_NAME || "holo",
      presetDir: env.PRESET_DIR || "preset",
      maxTurns: toPositiveInt(env.CHAT_MAX_TURNS, 6),
      acceptImages: (env.ACCEPT_IMAGES ?? "false").toLowerCase() === "true",
      visionAlias: env.VISION_ALIAS || "vision",
      imagePrompt:
        env.IMAGE_PROMPT ||
        "你现在是一个图片描述大师。你需要根据下面提供的图片，对该图片或者图片列表生成 150-400 字的中文描述。",
      replyMaxLength: toPositiveInt(env.REPLY_MAX_LENGTH, 500),
      botId: toPositiveInt(env.BOT_ID, 1000000000),
      triggerKeywords: (env.TRIGGER_KEYWORDS ?? "赫萝~")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      whitelistGroupIds: (env.WHITELIST_GROUP_IDS ?? "")
        .split(",")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0),
      errorAlertGroupId: toPositiveInt(env.ERROR_ALERT_GROUP_ID, 1000000001),
      contextLimit: toPositiveInt(env.CHAT_CONTEXT_LIMIT, 30),
      cooldownMs: toPositiveInt(env.CHAT_COOLDOWN_MS, 10000),
      replyTimeoutMs: toPositiveInt(env.CHAT_REPLY_TIMEOUT_MS, 60000),
      prdC: Number.parseFloat(env.PRD_C ?? "0.0038") || 0.0038,
      rateLimitWindowMs: toPositiveInt(env.RATE_LIMIT_WINDOW_MS, 300000),
      rateLimitMaxRequests: toPositiveInt(env.RATE_LIMIT_MAX_REQUESTS, 10),
    },
    db: {
      host: env.DB_HOST || "127.0.0.1",
      port: toPositiveInt(env.DB_PORT, 3306),
      user: env.DB_USER || "root",
      password: env.DB_PASSWORD || "",
      database: env.DB_DATABASE || "amyluna",
      poolMax: toPositiveInt(env.DB_POOL_MAX, 10),
      poolIdleTimeoutMs: toPositiveInt(env.DB_POOL_IDLE_TIMEOUT_MS, 30000),
    },
    mcp: { servers: parseMcpServers(env.MCP_SERVERS_JSON) },
    silentTool: {
      queuedTools: new Set(
        (env.SILENT_TOOL_QUEUE ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    },
    taskQueue: {
      serialTools: new Set(
        (env.TASK_QUEUE_SERIAL ?? "")
          .split(",")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean),
      ),
    },
    tts: {
      baseUrl: (env.TTS_BASE_URL || "http://127.0.0.1:9880").replace(/\/$/, ""),
      voice: env.TTS_VOICE || "holo",
      voiceConfigDir: env.TTS_VOICE_CONFIG_DIR || "/home/USER/pythonprojects/audiobook_prepose",
      outputDir: env.TTS_OUTPUT_DIR || "data/tts/",
      sendMode: validateTtsSendMode(env.TTS_SEND_MODE),
      apiTimeoutMs: toPositiveInt(env.TTS_API_TIMEOUT_MS, 120000),
      maxRetries: toPositiveInt(env.TTS_MAX_RETRIES, 1),
      maxTextLen: toPositiveInt(env.TTS_MAX_TEXT_LEN, 300),
      defaultLang: env.TTS_DEFAULT_LANG || "zh",
      fileTtlMs: toPositiveInt(env.TTS_FILE_TTL_MS, 86400000),
    },
    text2image: {
      baseUrl: (env.T2I_BASE_URL || "https://token.sensenova.cn/v1").replace(/\/$/, ""),
      apiKey: env.T2I_API_KEY || "",
      promptModel: env.T2I_PROMPT_MODEL || "deepseek-v4-flash",
      imageModel: env.T2I_IMAGE_MODEL || "sensenova-u1-fast",
      imageSize: env.T2I_IMAGE_SIZE || "2752x1536",
      outputDir: env.T2I_OUTPUT_DIR || "/home/USER/temp_files/text2image/",
      promptTimeoutMs: toPositiveInt(env.T2I_PROMPT_TIMEOUT_MS, 60000),
      imageTimeoutMs: toPositiveInt(env.T2I_IMAGE_TIMEOUT_MS, 120000),
      maxRetries: toPositiveInt(env.T2I_MAX_RETRIES, 1),
      maxTopicLen: toPositiveInt(env.T2I_MAX_TOPIC_LEN, 200),
      fileTtlMs: toPositiveInt(env.T2I_FILE_TTL_MS, 86400000),
      presetPath: env.T2I_PRESET_PATH || "preset/text2image.yaml",
    },
    muriAgent: {
      maxTurns: toPositiveInt(env.MURI_AGENT_MAX_TURNS, 4),
      model: env.MURI_AGENT_MODEL || undefined,
    },
    watchdog: {
      intervalMs: toPositiveInt(env.WATCHDOG_INTERVAL_MS, 5000),
      maxFailures: toPositiveInt(env.WATCHDOG_MAX_FAILURES, 3),
    },
  };
}
