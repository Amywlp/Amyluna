/**
 * P1 发送 API — 通过 WS 连接发送群消息。
 * 从 v1 snowluma/api.ts 迁移。
 */

import type { WsClient } from "./ws-client";
import type { MessageSegment } from "../common/types/onebot";
import { createLogger } from "../common/logger";

const log = createLogger("P1.send");

// ─── 结果类型 ──────────────────────────────────────────

export interface SendGroupMessageResult {
  message_id: number;
}

export interface ForwardNode {
  user_id?: number;
  uin?: number;
  nickname?: string;
  name?: string;
  content?: string | MessageSegment[] | ForwardNode[];
  message?: string | MessageSegment[] | ForwardNode[];
  time?: number;
}

export interface SendForwardResult {
  message_id: number;
  res_id?: string;
  forward_id?: string;
}

export interface ForwardMessageNode {
  message_id: number;
  user_id: number;
  time: number;
  message_type: "group" | "private";
  sender: { user_id: number; nickname: string; card?: string };
  group_id?: number;
  message: MessageSegment[];
}

// ─── API 函数 ──────────────────────────────────────────

export async function getForwardMsg(
  client: WsClient,
  id: string,
): Promise<ForwardMessageNode[]> {
  log.info("getForwardMsg.start", { id });
  const result = await client.request<{ messages: ForwardMessageNode[] }>("get_forward_msg", { id });
  log.info("getForwardMsg.done", { id, count: result.messages.length });
  return result.messages;
}

export interface GroupFileUrlResult {
  url: string;
}

/** 获取群文件下载 URL（凭 file_id 刷新时效链接）。 */
export async function getGroupFileUrl(
  client: WsClient,
  groupId: number,
  fileId: string,
): Promise<GroupFileUrlResult> {
  log.info("getGroupFileUrl.start", { group_id: groupId, file_id: fileId });
  const result = await client.request<GroupFileUrlResult>("get_group_file_url", {
    group_id: groupId,
    file_id: fileId,
  });
  log.info("getGroupFileUrl.done", { hasUrl: !!result.url });
  return result;
}

export async function sendGroupForwardMessage(
  client: WsClient,
  groupId: number,
  nodes: ForwardNode[],
): Promise<SendForwardResult> {
  log.info("sendGroupForwardMessage.start", { group_id: groupId, nodeCount: nodes.length });
  return client.request<SendForwardResult>("send_group_forward_msg", {
    group_id: groupId,
    messages: nodes,
  }).then((result) => {
    log.info("sendGroupForwardMessage.done", { group_id: groupId, message_id: result.message_id });
    return result;
  }).catch((error) => {
    log.error("sendGroupForwardMessage.fail", { group_id: groupId, error: String(error) });
    throw error;
  });
}

export async function sendGroupMessage(
  client: WsClient,
  groupId: number,
  message: string | MessageSegment[],
): Promise<SendGroupMessageResult> {
  log.info("sendGroupMessage.start", { group_id: groupId });
  return client.request<SendGroupMessageResult>("send_group_msg", {
    group_id: groupId,
    message,
  }).then((result) => {
    log.info("sendGroupMessage.done", { group_id: groupId, message_id: result.message_id });
    return result;
  }).catch((error) => {
    log.error("sendGroupMessage.fail", { group_id: groupId, error: String(error) });
    throw error;
  });
}

// ─── QQ 互动 API ──────────────────────────────────────

/** 点赞用户（QQ 资料卡点赞）。 */
export async function sendLike(
  client: WsClient,
  userId: number,
  times = 1,
): Promise<void> {
  log.info("sendLike", { user_id: userId, times });
  await client.request("send_like", { user_id: userId, times });
}

/** 私聊拍一拍。 */
export async function sendPoke(
  client: WsClient,
  userId: number,
): Promise<void> {
  log.info("sendPoke", { user_id: userId });
  await client.request("send_poke", { user_id: userId });
}

/** 群拍一拍。 */
export async function groupPoke(
  client: WsClient,
  groupId: number,
  userId: number,
): Promise<void> {
  log.info("groupPoke", { group_id: groupId, user_id: userId });
  await client.request("group_poke", { group_id: groupId, user_id: userId });
}

/** 群聊表情回应。code 为 QQ 表情 ID 字符串。 */
export async function setGroupReaction(
  client: WsClient,
  messageId: number,
  code: string,
  groupId?: number,
): Promise<void> {
  log.info("setGroupReaction", { message_id: messageId, code, group_id: groupId });
  const params: Record<string, unknown> = { message_id: messageId, code };
  if (groupId) params.group_id = groupId;
  await client.request("set_group_reaction", params);
}
