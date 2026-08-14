/**
 * OneBot v11 群消息事件和 WS API 响应的最小类型。
 * 迁移自 v1 snowluma/types.ts。
 */

export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface Sender {
  user_id: number;
  nickname: string;
  card?: string;
  role?: string;
  sex?: string;
  age?: number;
}

export interface GroupMessageEvent {
  post_type: "message";
  message_type: "group";
  sub_type?: string;
  message_id: number;
  message_seq?: number;
  group_id: number;
  group_name?: string;
  user_id: number;
  message: MessageSegment[] | string;
  raw_message?: string;
  font?: number;
  self_id: number;
  time: number;
  sender?: Sender;
  anonymous?: unknown;
}

export type OneBotEvent =
  | GroupMessageEvent
  | {
      post_type: string;
      [key: string]: unknown;
    };

export interface OneBotApiResponse<T = unknown> {
  status: string;
  retcode: number;
  data: T;
  echo?: string;
}
