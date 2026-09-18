/**
 * 标准工具文本标记剥离 — 唯一来源。
 *
 * 背景：标准工具（function calling）只能由 P3 的 function calling 机制触发。
 * 模型偶尔会把调用写成回复正文里的文本标记（如 resolve_media(-68609454)），
 * 系统不会解析，会原样泄漏给用户，因此正文发出前统一剥离。
 *
 * 历史坑（2026-09-13）：同一份名单曾在 P2（src/convmgr/silent-text-extractor.ts）
 * 与 P3（src/llmcore/conversation-loop.ts）各存一份正则，两边各改各的，
 * 结果 analyze_video 只补进了一处、另一处漏项；而 analyze_video 本身
 * 又已并入 resolve_media 不再注册，属于坏名单叠加漏名单。
 * 现统一到本模块：以后增删工具名只改 STD_TOOL_TEXT_NAMES 一处。
 */

/** 需要剥离的工具名（正则片段）。增删工具只改这里。 */
const STD_TOOL_TEXT_NAMES = [
  "search_song",
  "send_song_card",
  "analyze_video",
  "resolve_media",
  "context_review",
  "web_search",
  "get_time",
  "temp_mute",
  "ragflow_ragflow_retrieval",
  "filesystem_\\w+",
].join("|");

/** 完整模式：词边界 + 工具名 + 括号内容（兼容半角/全角括号、数字/字符串/key=val 参数） */
const STD_TOOL_TEXT_PATTERN = `\\b(?:${STD_TOOL_TEXT_NAMES})\\s*[（(][^（()）]*[)）]`;

/**
 * 剥离文本中所有被误写成文本标记的标准工具调用。
 * 每次调用新建正则，避免 /g 标志的 lastIndex 状态在多次调用间相互污染。
 */
export function stripStdToolText(text: string): string {
  if (!text) return text;
  return text.replace(new RegExp(STD_TOOL_TEXT_PATTERN, "g"), "");
}
