/**
 * 数据库初始化脚本：创建 amyluna 库及三张表。
 *
 * 用法:
 *   npx tsx src/common/db/init-db.ts
 *
 * 注意：先连到 MySQL（不指定 database），CREATE DATABASE IF NOT EXISTS，
 * 再连到 amyluna 执行 ensureTables。
 */

import mysql from "mysql2/promise";
import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";

// 手动加载 .env
const envFile = path.resolve(process.cwd(), ".env");
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config({ path: path.resolve(process.cwd(), ".env.example") });
}

const env = process.env;

const DB_HOST = env.DB_HOST || "127.0.0.1";
const DB_PORT = Number.parseInt(env.DB_PORT ?? "3306", 10);
const DB_USER = env.DB_USER || "root";
const DB_PASSWORD = env.DB_PASSWORD || "";
const DB_DATABASE = env.DB_DATABASE || "amyluna";

async function main(): Promise<void> {
  console.log(`[init-db] Connecting to ${DB_HOST}:${DB_PORT} as ${DB_USER}...`);

  // Step 1: 创建数据库
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    charset: "utf8mb4",
  });

  console.log(`[init-db] Creating database "${DB_DATABASE}"...`);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  console.log(`[init-db] Database "${DB_DATABASE}" ready.`);
  await conn.end();

  // Step 2: 连到 amyluna，创建表
  const { createPool, ensureTables } = await import("./pool");
  const { loadConfig } = await import("../config");

  const config = loadConfig();
  const pool = createPool(config.db);

  console.log("[init-db] Creating tables...");
  await ensureTables(pool);
  console.log("[init-db] All tables ready.");

  await pool.end();
  console.log("[init-db] Done.");
}

main().catch((err) => {
  console.error("[init-db] Error:", err);
  process.exit(1);
});
