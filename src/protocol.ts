// 协议类型（protocol/schema/frame.schema.json v1，PRD v1.2）。

export type ConvType = 'c2c' | 'group' | 'room';
export type Platform = 'android' | 'ios' | 'web' | 'pc';

export interface MsgBody {
  text?: string;
  data?: unknown;
}

/** 服务端的一条消息（msg 帧、sync 结果）。 */
export interface ServerMessage {
  msgId: string;
  clientMsgId: string;
  convId: string;
  seq: number;
  from: string;
  type: 'text' | 'custom';
  body: MsgBody;
  ts: number;
}

export interface LastMsg {
  msgId: string;
  from: string;
  type: string;
  text: string;
  ts: number;
}

/** convs 的一项、convAdded 的内容。 */
export interface ServerConversation {
  convId: string;
  type: ConvType;
  name: string;
  maxSeq: number;
  readSeq: number;
  minSeq: number;
  unread: number;
  lastMsg: LastMsg | null;
  updatedAt: number;
}

export interface SendAck {
  msgId: string;
  convId: string;
  seq: number;
  ts: number;
}

export interface SyncAck {
  messages: ServerMessage[];
  hasMore: boolean;
}

export interface ConvsAck {
  convs: ServerConversation[];
  truncated: boolean;
}

export interface AuthAck {
  userId: string;
  serverTime: number;
}

export type ServerEvent =
  | { type: 'kicked'; reason: string }
  | { type: 'convAdded'; conv: ServerConversation }
  | { type: 'convRemoved'; convId: string }
  | { type: 'readUpdated'; convId: string; readSeq: number };

/** 下行帧。 */
export interface InboundFrame {
  id?: string;
  cmd: string;
  data?: unknown;
  error?: { code: number; msg: string };
}

/** 单聊会话 ID：c2c:{较小 userId}:{较大 userId}，按 ASCII 字节序比较（与服务端一致）。 */
export function c2cConvId(a: string, b: string): string {
  return a < b ? `c2c:${a}:${b}` : `c2c:${b}:${a}`;
}

export function groupConvId(groupId: string): string {
  return `group:${groupId}`;
}

/** 解析会话 ID，得到发消息需要的 convType 和 to（单聊为对方）。 */
export function parseConvId(convId: string, self: string): { convType: ConvType; to: string } {
  const [type, a = '', b = ''] = convId.split(':');
  if (type === 'c2c') return { convType: 'c2c', to: a === self ? b : a };
  if (type === 'group' || type === 'room') return { convType: type, to: a };
  throw new Error(`invalid convId ${convId}`);
}
