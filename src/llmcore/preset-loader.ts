/**
 * Preset 加载器 — 启动时扫描 preset/ 目录，加载所有 .yaml 文件。
 *
 * YAML front-matter 格式:
 *   name: holo
 *   trigger_keywords:
 *     - 赫萝~
 *   ---
 *   (system prompt body)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../common/logger";

const log = createLogger("P3.preset");

export interface PresetConfig {
  name: string;
  /** front-matter 之后的全部内容（system prompt body） */
  systemPrompt: string;
  triggerKeywords: string[];
}

/**
 * 解析 YAML front-matter。
 * 返回 { frontMatter: Record<string, unknown>, body: string }。
 */
function parseFrontMatter(raw: string): { frontMatter: Record<string, unknown>; body: string } {
  const parts = raw.split("---");
  if (parts.length < 3) {
    // 无 front-matter，整个文件即是 system prompt
    return { frontMatter: {}, body: raw.trim() };
  }

  const yamlBlock = parts[1] ?? "";
  const body = parts.slice(2).join("---").trim();

  // 简单行解析（不依赖 js-yaml 库）
  const fm: Record<string, unknown> = {};
  for (const line of yamlBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key) continue;

    // 处理列表项（下一行以 "- " 开头）
    if (value === "" || value === "[]") {
      fm[key] = [];
      continue;
    }

    // 简单字符串值
    fm[key] = value.replace(/^["']|["']$/g, "");
  }

  return { frontMatter: fm, body };
}

/**
 * 解析 YAML 中的列表（在 front-matter 之后查找缩进的 - item 行）。
 * 简化实现：将 body 中以 "- " 开头的行作为数组元素。
 */
function parseYamlList(yamlBlock: string, key: string): string[] {
  const lines = yamlBlock.split("\n");
  let inTarget = false;
  const items: string[] = [];
  for (const line of lines) {
    if (inTarget) {
      const match = line.match(/^\s+-\s+(.+)/);
      if (match) {
        items.push(match[1].trim().replace(/^["']|["']$/g, ""));
      } else if (line.trim() !== "" && !line.startsWith(" ")) {
        break;
      }
    }
    if (line.startsWith(key + ":")) {
      inTarget = true;
    }
  }
  return items;
}

export class PresetLoader {
  private presets = new Map<string, PresetConfig>();

  /** 扫描并加载 preset/ 目录下所有 .yaml 文件 */
  loadAll(presetDir: string): void {
    const resolved = path.resolve(process.cwd(), presetDir);
    log.info("load.start", { dir: resolved });

    if (!fs.existsSync(resolved)) {
      log.warn("load.noDir", { dir: resolved });
      return;
    }

    const files = fs.readdirSync(resolved).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const file of files) {
      const filePath = path.join(resolved, file);
      const raw = fs.readFileSync(filePath, "utf8");
      const parts = raw.split("---");

      let fm: Record<string, unknown> = {};
      let body: string;

      if (parts.length >= 3) {
        // 有标准 --- 定界符
        const yamlBlock = parts[1] ?? "";
        fm = parseFrontMatter(raw).frontMatter;
        const keywords = parseYamlList(yamlBlock, "trigger_keywords");
        if (keywords.length > 0) {
          fm.trigger_keywords = keywords;
        }
        body = parts.slice(2).join("---").trim();
      } else {
        // 无 --- 定界符：从文件开头检测 front-matter 行
        const lines = raw.split("\n");
        const fmLines: string[] = [];
        const bodyStart: number = (() => {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            const trimmed = line.trim();
            // 空行 → front-matter 结束
            if (trimmed === "") {
              return i + 1;
            }
            // 以 "- " 开头的缩进行 → 上一行的列表项
            if (line.startsWith("  - ") || line.startsWith("\t- ")) {
              fmLines.push(line);
              continue;
            }
            // 包含 ":" 且值可能是字符串或空 → front-matter 键值对
            const colonIdx = line.indexOf(":");
            if (colonIdx > 0 && !line.startsWith("#") && !line.startsWith("//")) {
              fmLines.push(line);
              continue;
            }
            // 其他行 → front-matter 结束
            return i;
          }
          return lines.length;
        })();

        const fmBlock = fmLines.join("\n");
        fm = parseFrontMatter(`---\n${fmBlock}\n---`).frontMatter;
        const keywords = parseYamlList(fmBlock, "trigger_keywords");
        if (keywords.length > 0) {
          fm.trigger_keywords = keywords;
        }
        body = lines.slice(bodyStart).join("\n").trim();
      }

      // key 始终用文件名（不含扩展名），YAML 中的 name 字段仅作展示用途
      const key = path.basename(file, path.extname(file));
      const displayName = String(fm.name ?? key);

      const preset: PresetConfig = {
        name: displayName,
        systemPrompt: body,
        triggerKeywords: Array.isArray(fm.trigger_keywords)
          ? fm.trigger_keywords.map(String)
          : [],
      };

      this.presets.set(key, preset);
      log.info("load.file", { file, key, displayName, bodyLen: body.length, keywords: preset.triggerKeywords });
    }

    log.info("load.done", { count: this.presets.size });
  }

  getPreset(name: string): PresetConfig {
    // 先按文件名 key 精确匹配，再按 YAML display name 匹配
    const byKey = this.presets.get(name);
    if (byKey) return byKey;

    for (const preset of this.presets.values()) {
      if (preset.name === name) return preset;
    }

    const keys = Array.from(this.presets.keys());
    const names = Array.from(this.presets.values()).map((p) => p.name);
    throw new Error(
      `Preset not found: "${name}". Available keys: [${keys.join(", ")}], display names: [${names.join(", ")}]`,
    );
  }

  getAll(): PresetConfig[] {
    return Array.from(this.presets.values());
  }
}
