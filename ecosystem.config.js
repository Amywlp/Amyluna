/**
 * amyluna v2 — PM2 三进程启动配置
 *
 * 启动:   pm2 start ecosystem.config.js
 * 停止:   pm2 stop amyluna
 * 重启:   pm2 restart amyluna
 * 删除:   pm2 delete amyluna
 * 状态:   pm2 status
 * 日志:   pm2 logs amyluna
 * 保存:   pm2 save          (持久化到系统重启后自动恢复)
 */

module.exports = {
  apps: [
    // ── P3: LLM Core (:3103) — 最先启动 ──
    {
      name: "amyluna-p3",
      script: "npx",
      args: "tsx src/llmcore/index.ts",
      cwd: __dirname,
      interpreter: "none",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: "./logs/p3-out.log",
      error_file: "./logs/p3-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },

    // ── P2: Conversation Manager (:3102) ──
    {
      name: "amyluna-p2",
      script: "npx",
      args: "tsx src/convmgr/index.ts",
      cwd: __dirname,
      interpreter: "none",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: "./logs/p2-out.log",
      error_file: "./logs/p2-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },

    // ── P1: Receiver (:3101) — 最后启动 ──
    {
      name: "amyluna-p1",
      script: "npx",
      args: "tsx src/receiver/index.ts",
      cwd: __dirname,
      interpreter: "none",
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: "./logs/p1-out.log",
      error_file: "./logs/p1-err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
