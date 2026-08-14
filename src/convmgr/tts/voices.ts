/**
 * VoiceRegistry — 根据语言标签查找语音角色配置。
 *
 * 配置目录结构:
 *   TTS_VOICE_CONFIG_DIR/
 *     {voice}_infer_config.json        ← 基础配置
 *     {voice}_{lang}_infer_config.json ← 语言覆盖配置（优先）
 *
 * 查找顺序:
 *   1. {voice}_{lang}_infer_config.json  → 命中则使用
 *   2. {voice}_infer_config.json          → 回退
 *   3. 都未找到 → null
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../../common/logger";
import type { VoiceConfig } from "./types";

const log = createLogger("P2.tts.voices");

export class VoiceRegistry {
  /** voiceName → VoiceConfig */
  private readonly configs = new Map<string, VoiceConfig>();
  /** 默认角色名 */
  private readonly defaultVoice: string;

  constructor(
    private readonly configDir: string,
    defaultVoice: string,
  ) {
    this.defaultVoice = defaultVoice;
  }

  /**
   * 扫描配置目录，加载所有语音配置。
   * 失败返回 false，不阻止 P2 启动（已注册的 TTS 调用将快速失败）。
   */
  load(): boolean {
    let loaded = 0;
    try {
      const entries = fs.readdirSync(this.configDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const name = entry.name;
        // 匹配 {voice}_infer_config.json 或 {voice}_{lang}_infer_config.json
        const match = name.match(/^(.+)_infer_config\.json$/);
        if (!match) continue;

        const key = match[1]!; // 如 "holo" 或 "holo_ja"
        try {
          const raw = fs.readFileSync(path.join(this.configDir, name), "utf-8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const config = this.parseVoiceConfig(parsed, key);
          this.configs.set(key, config);
          loaded++;
          log.debug("voice.loaded", { key, refAudio: config.refAudioPath });
        } catch (err) {
          log.warn("voice.parseFail", { file: name, error: String(err) });
        }
      }
    } catch (err) {
      log.error("voice.scanFail", { configDir: this.configDir, error: String(err) });
      return false;
    }

    log.info("voice.registryReady", { loaded, total: this.configs.size, defaultVoice: this.defaultVoice });
    return loaded > 0;
  }

  /**
   * 根据语言查找语音配置。
   *
   * 查找顺序:
   *   1. {voice}_{lang}_infer_config.json → 命中直接使用
   *   2. {voice}_infer_config.json → 基础配置
   *   3. 若基础配置的 prompt_lang ≠ 目标 lang，动态构建语言适配配置:
   *      - 目标语言与 prompt_lang 一致 → 原样返回（aux_ref_audio_paths 用于跨语言质量增强）
   *      - 目标语言与 prompt_lang 不同 → 从 aux_ref_audio_paths 中选取目标语言参考音频
   *        作为主参考，原主参考作为辅参考
   *
   * @param lang 语言标签（如 "ja", "zh"）
   * @returns VoiceConfig 或 null（未找到时）
   */
  resolve(lang: string): VoiceConfig | null {
    const voice = this.defaultVoice;
    const targetLang = lang.toLowerCase();

    // 1. 优先语言特化配置: holo_ja_infer_config.json
    const langKey = `${voice}_${targetLang}`;
    const langConfig = this.configs.get(langKey);
    if (langConfig) {
      log.debug("voice.resolve.langSpecific", { langKey, voice });
      return langConfig;
    }

    // 2. 回退基础配置: holo_infer_config.json
    const baseConfig = this.configs.get(voice);
    if (!baseConfig) {
      log.warn("voice.resolve.notFound", { voice, lang, available: [...this.configs.keys()] });
      return null;
    }

    // 3. 语言的 prompt_lang 匹配 → 直接使用（aux_ref_audio_paths 用于跨语言增强）
    if (baseConfig.promptLang === targetLang) {
      log.debug("voice.resolve.base", { voice, lang, promptLang: baseConfig.promptLang });
      return baseConfig;
    }

    // 4. prompt_lang 不匹配 → 从 aux 中选取目标语言参考音频
    const auxEntries = this.loadAuxLabels(baseConfig.auxRefAudioPaths ?? [], targetLang);
    if (auxEntries.length === 0) {
      // 没有目标语言的 aux 参考音频 → 回退到基础配置
      log.warn("voice.resolve.noAuxForLang", { voice, targetLang, promptLang: baseConfig.promptLang });
      return baseConfig;
    }

    // 随机选取一条作为主参考，其余作为辅参考
    const picked = auxEntries[Math.floor(Math.random() * auxEntries.length)]!;
    const restPaths = auxEntries
      .filter((e) => e.path !== picked.path)
      .map((e) => e.path);

    // JA 适配使用 JA 专用的模型权重
    const adapted: VoiceConfig = {
      name: `${voice}_${targetLang}`,
      refAudioPath: picked.path,
      promptLang: targetLang,
      promptText: picked.label,
      auxRefAudioPaths: restPaths.length > 0 ? restPaths : undefined,
      // JA 专用模型路径（与 ZH 不同）
      gptModelPath: "/home/USER/桌面/sovits/GPT-SoVITS-v2pro-20250604/GPT_weights_v2Pro/holov2-e15.ckpt",
      sovitsModelPath: "/home/USER/桌面/sovits/GPT-SoVITS-v2pro-20250604/SoVITS_weights_v2ProPlus/holov4_e20_s3500.pth",
      inference: { ...baseConfig.inference, textLang: targetLang },
    };

    log.info("voice.resolve.adapted", {
      voice,
      targetLang,
      refAudio: picked.path.split("/").pop(),
      promptText: picked.label.slice(0, 40),
      auxCount: restPaths.length,
      totalCandidates: auxEntries.length,
    });
    return adapted;
  }

  /** 是否有可用配置 */
  get enabled(): boolean {
    return this.configs.size > 0;
  }

  // ─── 私有 ──────────────────────────────────────────────

  /**
   * 从 aux_ref_audio_paths 中筛选目标语言的参考音频，
   * 并读取对应的 _label.txt 标注文件。
   */
  private loadAuxLabels(
    auxPaths: string[],
    targetLang: string,
  ): Array<{ path: string; label: string }> {
    const langMarker = `/${targetLang}/`;
    const entries: Array<{ path: string; label: string }> = [];

    for (const wavPath of auxPaths) {
      if (!wavPath.includes(langMarker)) continue;

      // 读取 _label.txt: holo_053.wav → holo_053_label.txt
      const labelPath = wavPath.replace(/\.wav$/i, "_label.txt");
      let label = "";
      try {
        label = fs.readFileSync(labelPath, "utf-8").trim();
      } catch {
        log.warn("voice.loadAuxLabel.missing", { wavPath, labelPath });
        continue;
      }

      if (label) {
        entries.push({ path: wavPath, label });
      }
    }

    log.debug("voice.loadAuxLabels", { targetLang, found: entries.length, total: auxPaths.length });
    return entries;
  }

  /** 解析 SoVITS 推理配置 JSON */
  private parseVoiceConfig(raw: Record<string, unknown>, key: string): VoiceConfig {
    // SoVITS v2Pro config 格式：顶层 key 的值可能是 Python dict 字符串
    // 例如: "reference": "{'ref_audio_path': '/path/to.wav', 'prompt_lang': 'zh', ...}"
    // 先尝试将字符串值解析为对象，合并到 raw 中
    const merged = { ...raw };
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && (v.startsWith("{") || v.startsWith("'{"))) {
        const parsed = parsePythonDict(v);
        if (parsed && Object.keys(parsed).length > 0) {
          merged[k] = parsed;
        }
      }
    }

    // 从 reference 子对象（或顶层）提取字段
    const refObj = (merged.reference ?? merged) as Record<string, unknown>;
    const refAudioPath = String(refObj.ref_audio_path ?? refObj.refAudioPath ?? "");
    const promptLang = String(refObj.prompt_lang ?? refObj.promptLang ?? "zh");
    const promptText = String(refObj.prompt_text ?? refObj.promptText ?? "");

    const auxRaw: unknown = refObj.aux_ref_audio_paths ?? refObj.auxRefAudioPaths;
    const auxRefAudioPaths: string[] | undefined = Array.isArray(auxRaw)
      ? (auxRaw as unknown[]).map(String).filter(Boolean)
      : undefined;

    // 从 inference 子对象提取（对齐 batch_multi_seed.py call_tts 参数）
    const infObj = (merged.inference ?? merged) as Record<string, unknown>;
    const inference = {
      textLang: pickStr(infObj, "text_lang", "textLang"),
      speedFactor: pickNum(infObj, "speed_factor", "speedFactor"),
      topK: pickNum(infObj, "top_k", "topK"),
      topP: pickNum(infObj, "top_p", "topP"),
      temperature: pickNum(infObj, "temperature"),
      repetitionPenalty: pickNum(infObj, "repetition_penalty", "repetitionPenalty"),
      textSplitMethod: pickStr(infObj, "text_split_method", "textSplitMethod"),
      fragmentInterval: pickNum(infObj, "fragment_interval", "fragmentInterval"),
      sampleSteps: pickNum(infObj, "sample_steps", "sampleSteps"),
      superSampling: pickBool(infObj, "super_sampling", "superSampling"),
      parallelInfer: pickBool(infObj, "parallel_infer", "parallelInfer"),
      batchSize: pickNum(infObj, "batch_size", "batchSize"),
      batchThreshold: pickNum(infObj, "batch_threshold", "batchThreshold"),
      splitBucket: pickBool(infObj, "split_bucket", "splitBucket"),
      streamingMode: pickBool(infObj, "streaming_mode", "streamingMode"),
      mediaType: pickStr(infObj, "media_type", "mediaType"),
    };

    // 从 model 子对象提取模型权重路径
    const modelObj = (merged.model ?? merged) as Record<string, unknown>;
    const gptModelPath = pickStr(modelObj, "gpt_weights") || undefined;
    const sovitsModelPath = pickStr(modelObj, "sovits_weights") || undefined;

    return {
      name: key,
      refAudioPath,
      promptLang,
      promptText,
      auxRefAudioPaths,
      gptModelPath,
      sovitsModelPath,
      inference,
    };
  }
}

/**
 * 解析 Python 风格 dict 字符串为 Record<string, unknown>。
 * 格式: "{'key': 'value', 'key2': 123, 'key3': True}"
 * 仅处理简单类型（字符串、数字、布尔、列表），不处理嵌套 dict。
 */
function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof obj[k] === "string") return obj[k] as string;
  }
  return undefined;
}

function pickNum(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    if (typeof obj[k] === "number") return obj[k] as number;
  }
  return undefined;
}

function pickBool(obj: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const k of keys) {
    if (typeof obj[k] === "boolean") return obj[k] as boolean;
  }
  return undefined;
}

function parsePythonDict(raw: string): Record<string, unknown> | null {
  try {
    // 去掉外层花括号
    let body = raw.trim();
    if (body.startsWith("'{")) body = body.slice(1);
    if (body.startsWith("{")) body = body.slice(1);
    if (body.endsWith("}")) body = body.slice(0, -1);
    if (body.endsWith("'")) body = body.slice(0, -1);

    // 先尝试标准 JSON 解析
    try {
      const result = JSON.parse(raw);
      if (typeof result === "object" && result !== null && !Array.isArray(result)) {
        return result as Record<string, unknown>;
      }
    } catch { /* 不是标准 JSON，继续 Python 风格解析 */ }

    const result: Record<string, unknown> = {};

    // 逐对解析 key: value
    // 匹配模式: 'key': value 或 "key": value
    const pairRe = /(['"])([^'"]*)\1\s*:\s*(['"]?)([^,}]+?)\3(?=\s*(?:,|$))/g;
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(body)) !== null) {
      const key = match[2]!;
      let value: unknown = match[4]!.trim();

      // 去掉可能残留的引号
      if (typeof value === "string") {
        if ((value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))) {
          value = value.slice(1, -1);
        }
        // 布尔值
        if (value === "True") value = true;
        else if (value === "False") value = false;
        else if (value === "None") value = null;
        // 整数/浮点数
        else if (/^-?\d+$/.test(value as string)) value = Number.parseInt(value as string, 10);
        else if (/^-?\d+\.\d+$/.test(value as string)) value = Number.parseFloat(value as string);
      }

      result[key] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}
