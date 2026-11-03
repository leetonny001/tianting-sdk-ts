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
  /** 群成员数（PRD-core V-07）；单聊没有，旧服务端也可能没有。 */
  memberCount?: number;
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
  | { type: 'convRemoved'; convId: string; reason?: string }
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

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 会话 ID 不合法（invalid），或者合法但自己不是参与者（notParticipant）。 */
export class ConvIdError extends Error {
  constructor(
    readonly kind: 'invalid' | 'notParticipant',
    convId: string,
  ) {
    super(`${kind} convId ${JSON.stringify(convId)}`);
    this.name = 'ConvIdError';
  }
}

/**
 * 严格解析会话 ID（PRD-ui G-UI-03，用例 protocol/vectors/convid.json）：界面用它判断路由。
 * 单聊必须恰好三段、两个 userId 合法且按 ASCII 字节序严格递增，其中一个是 self；群必须恰好两段且 groupId 合法；
 * 一期没有聊天室，room 和其他前缀一律不合法。
 */
export function parseConvIdStrict(convId: string, self: string): { convType: 'c2c' | 'group'; to: string } {
  const parts = convId.split(':');
  if (parts[0] === 'c2c' && parts.length === 3) {
    const [, a, b] = parts as [string, string, string];
    if (!ID_RE.test(a) || !ID_RE.test(b) || !(a < b)) throw new ConvIdError('invalid', convId);
    if (a !== self && b !== self) throw new ConvIdError('notParticipant', convId);
    return { convType: 'c2c', to: a === self ? b : a };
  }
  if (parts[0] === 'group' && parts.length === 2 && ID_RE.test(parts[1]!)) {
    return { convType: 'group', to: parts[1]! };
  }
  throw new ConvIdError('invalid', convId);
}

/** 单聊会话的对方 userId；群会话返回 null。 */
export function peerId(conv: { convId: string; type: string }, self: string): string | null {
  if (conv.type !== 'c2c') return null;
  const [, a = '', b = ''] = conv.convId.split(':');
  return a === self ? b : a;
}

/**
 * 解析会话 ID，得到发消息需要的 convType 和 to（单聊为对方）。
 * 只给 SDK 内部用：不校验格式和参与者，界面不得用它判断路由（用 parseConvIdStrict）。
 */
export function parseConvId(convId: string, self: string): { convType: ConvType; to: string } {
  const [type, a = '', b = ''] = convId.split(':');
  if (type === 'c2c') return { convType: 'c2c', to: a === self ? b : a };
  if (type === 'group' || type === 'room') return { convType: type, to: a };
  throw new Error(`invalid convId ${convId}`);
}
