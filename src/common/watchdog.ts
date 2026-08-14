/**
 * 三进程 Watchdog — 每进程定时 ping 其他两个进程。
 *
 * 注意: 不创建自己的 IpcServer —— 复用主进程的 IPC Server（已注册 ping handler）。
 * 仅创建 IpcClient 向 peer 发送 ping 请求。
 *
 * 用法:
 *   const wd = new Watchdog("P1", {
 *     pingTargets: [{ label: "P2", port: 3102 }, { label: "P3", port: 3103 }],
 *   });
 *   await wd.start();
 */
import { IpcClient } from "./ipc/client";
import { createLogger } from "./logger";

const WD_LOG = createLogger("watchdog");

export interface PingTarget {
  label: string;
  port: number;
}

export interface WatchdogOptions {
  pingTargets: PingTarget[];
  intervalMs?: number;
  maxFailures?: number;
  warmupMs?: number;
}

interface TargetState {
  target: PingTarget;
  client: IpcClient;
  consecutiveFailures: number;
  lastSuccess: number;
  connected: boolean;
}

export class Watchdog {
  private targets: TargetState[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly maxFailures: number;
  private readonly warmupMs: number;
  private startedAt = 0;
  private stopped = false;

  constructor(
    private readonly label: string,
    private readonly options: WatchdogOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 5000;
    this.maxFailures = options.maxFailures ?? 3;
    this.warmupMs = options.warmupMs ?? 10000;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.stopped = false;

    // 创建到各个目标的 IpcClient（pong 由主进程 IPC Server 的 ping handler 处理）
    for (const target of this.options.pingTargets) {
      const client = new IpcClient(target.port, `${this.label}→${target.label}`);
      const state: TargetState = {
        target,
        client,
        consecutiveFailures: 0,
        lastSuccess: Date.now(),
        connected: false,
      };
      this.targets.push(state);
      this.tryConnect(state);
    }

    // 启动定时 ping
    this.timer = setInterval(() => {
      if (this.stopped) return;
      void this.pingAll();
    }, this.intervalMs);

    WD_LOG.info("started", {
      label: this.label,
      targets: this.options.pingTargets.map((t) => t.label),
      intervalMs: this.intervalMs,
      maxFailures: this.maxFailures,
      warmupMs: this.warmupMs,
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const state of this.targets) {
      try {
        await state.client.disconnect();
      } catch {
        // ignore
      }
    }
    WD_LOG.info("stopped", { label: this.label });
  }

  private async tryConnect(state: TargetState): Promise<void> {
    try {
      await state.client.connect();
      state.connected = true;
      state.lastSuccess = Date.now();
      state.consecutiveFailures = 0;
    } catch {
      state.connected = false;
    }
  }

  private async pingAll(): Promise<void> {
    if (Date.now() - this.startedAt < this.warmupMs) return;

    for (const state of this.targets) {
      if (!state.connected) {
        await this.tryConnect(state);
        continue;
      }

      try {
        await state.client.request("ping", null as unknown as never, 3000);
        if (state.consecutiveFailures > 0) {
          WD_LOG.info("recovered", {
            from: this.label,
            to: state.target.label,
            consecutiveFailures: state.consecutiveFailures,
          });
        }
        state.consecutiveFailures = 0;
        state.lastSuccess = Date.now();
      } catch {
        state.consecutiveFailures++;
        WD_LOG.warn("ping.fail", {
          from: this.label,
          to: state.target.label,
          consecutive: state.consecutiveFailures,
          max: this.maxFailures,
        });

        if (state.consecutiveFailures >= this.maxFailures) {
          WD_LOG.error("watchdog.alert", {
            from: this.label,
            to: state.target.label,
            message: `${state.target.label} unreachable after ${state.consecutiveFailures} failures`,
          });
          state.connected = false;
          state.consecutiveFailures = 0;
        }
      }
    }
  }
}
