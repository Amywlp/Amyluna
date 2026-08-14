/**
 * 数据库连接与表结构验证脚本。
 *
 * 用法:
 *   npx tsx src/common/db/test-db.ts
 */

import * as dotenv from "dotenv";
import * as path from "node:path";
import * as fs from "node:fs";
import { createPool, ensureTables } from "./pool";
import { loadConfig } from "../config";

async function main(): Promise<void> {
  console.log("=== amyluna 数据库验证 ===\n");

  const config = loadConfig();
  console.log(`数据库: ${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`用户: ${config.db.user}\n`);

  // 1. 连接
  console.log("[1/4] 创建连接池...");
  const pool = createPool(config.db);
  const [rows] = await pool.query("SELECT 1 AS test");
  console.log(`  ✓ 连接成功: ${JSON.stringify((rows as unknown[])[0])}`);

  // 2. 确保表存在
  console.log("\n[2/4] 确保表结构...");
  await ensureTables(pool);

  // 3. 验证表结构
  console.log("\n[3/4] 验证表结构:");
  const tables = ["chat_messages", "token_usage", "user_affinity"];
  for (const table of tables) {
    const [cols] = await pool.query(`SHOW COLUMNS FROM ${table}`) as [unknown[], unknown];
    console.log(`\n  ${table} (${cols.length} 列):`);
    for (const col of cols as Array<{ Field: string; Type: string; Null: string; Key: string; Default: unknown }>) {
      console.log(`    ${col.Field.padEnd(25)} ${col.Type.padEnd(25)} ${col.Null === "NO" ? "NOT NULL" : "NULL    "} ${col.Key || " "}`);
    }
  }

  // 4. 验证索引
  console.log("\n[4/4] 验证索引:");
  for (const table of tables) {
    const [indexes] = await pool.query(`SHOW INDEX FROM ${table}`) as [unknown[], unknown];
    console.log(`\n  ${table}:`);
    for (const idx of indexes as Array<{ Key_name: string; Column_name: string; Non_unique: number }>) {
      const unique = idx.Non_unique === 0 ? "UNIQUE" : "INDEX";
      console.log(`    ${unique.padEnd(8)} ${idx.Key_name.padEnd(25)} (${idx.Column_name})`);
    }
  }

  await pool.end();
  console.log("\n=== 验证完成 ===");
}

main().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
