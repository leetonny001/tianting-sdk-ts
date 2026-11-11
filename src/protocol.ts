// 协议类型（protocol/schema/frame.schema.json v1，PRD-core v1.3；社交类型在 social.ts）。

export type ConvType = 'c2c' | 'group' | 'room';
export type Platform = 'android' | 'ios' | 'web' | 'pc';

/** 群提示消息（PRD-social F-SOC-29）：actor 为空表示系统操作；targets 最多 20 个，超过时带 count。 */
export interface TipBody {
  kind: string;
  actor: string;
  targets: string[];
  count?: number;
  text: string;
}

/**
 * 图片消息（PRD-chat F-FILE-02）。下行的 size、mime、宽高是服务端记录的真实值；expired=true 时对象已删除，不再发放地址。
 * 本地还没上传完的消息 fileId 是空字符串。
 */
export interface ImageBody {
  fileId: string;
  width?: number;
  height?: number;
  size?: number;
  mime?: string;
  expired?: boolean;
}

/** 文件消息（F-FILE-03）。name 是清洗后的文件名，过期后为空字符串（F-FILE-06 规则 3）。文件名不进日志。 */
export interface FileBody {
  fileId: string;
  name?: string;
  size?: number;
  mime?: string;
  expired?: boolean;
}

/**
 * 引用的状态（PRD-chat F-QUO-02 规则 1）：normal 带 text；recalled、deleted、expired 没有原文。
 * 将来可能有新的值：不认识的按"引用内容不可用"显示（quoteLabel）。
 */
export type QuoteState = 'normal' | 'recalled' | 'deleted' | 'expired' | (string & {});

/**
 * 下行的引用（F-QUO-01 规则 3、F-QUO-02），服务端下发时组装。原消息已不存在时 state=deleted，没有 seq、from、type。
 * text 只在 state=normal 时有：文本前 100 个码点；图片"[图片]"；文件"[文件] {文件名}"。引用文字不进日志。
 * 上行只发 {msgId}（send 的 quote 选项），SDK 本地待发的消息用已加载的原消息先拼一份同样的结构。
 */
export interface QuoteView {
  msgId: string;
  seq?: number;
  from?: string;
  type?: MsgType;
  state: QuoteState;
  text?: string;
}

/** @（F-MEN-01、02）：只在群聊、只有 text 能带。下发的是服务端过滤后的结果。 */
export interface Mentions {
  userIds?: string[];
  all?: boolean;
}

export interface MsgBody {
  text?: string;
  data?: unknown;
  tip?: TipBody;
  image?: ImageBody;
  file?: FileBody;
  /** 引用（C4）。 */
  quote?: QuoteView;
  /** @ 的人（C4）。 */
  mentions?: Mentions;
}

export type MsgType = 'text' | 'custom' | 'tip' | 'image' | 'file';

export type GroupRole = 'owner' | 'admin' | 'member';

/** 服务端的一条消息（msg 帧、sync 结果）。 */
export interface ServerMessage {
  msgId: string;
  clientMsgId: string;
  convId: string;
  seq: number;
  from: string;
  type: MsgType;
  /** 被删除的消息没有 body（PRD-core F-MSG-05 规则 7）。 */
  body?: MsgBody;
  ts: number;
  /** 没有正文：后台删除，或撤回（这时 recalled 也是 true，PRD-chat F-RCL-01 规则 5a）。 */
  deleted?: boolean;
  deletedAt?: number;
  /** 被撤回（C4）：只在为 true 时出现，同时 deleted=true、没有 body。 */
  recalled?: boolean;
  recalledAt?: number;
  /** 撤回的操作者：发送者本人，或群主、管理员。 */
  recalledBy?: string;
}

export interface LastMsg {
  msgId: string;
  from: string;
  type: string;
  /** 最后一条消息被删除时没有 text（deleted = true）。 */
  text?: string;
  ts: number;
  deleted?: boolean;
  /** 最后一条被撤回（F-RCL-03 规则 4，C4）：同时 deleted=true、没有 text、带 recalledBy。 */
  recalled?: boolean;
  recalledBy?: string;
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
  /** 群里我的角色（M4）；单聊没有。 */
  myRole?: GroupRole;
  /** 我在该群被禁言时才有，永久为 null（第二批）。 */
  mutedUntil?: number | null;
  /** 该群开启了全群禁言时才有（P1，F-ADM-42）；群主、管理员也带，但不受限。 */
  allMuted?: boolean;
  /** 已有消息的展示内容变化的版本号（C2：文件过期），变化时重拉这个会话（F-RCL-03 规则 2）。老服务端没有。 */
  modVer?: number;
  /** 未读中提及我的数量，含 @ 所有人（F-MEN-03 规则 1，C4）。开关关闭或老服务端没有这个字段。 */
  mentionUnread?: number;
  /** 未读里第一条提及我的 seq；mentionUnread=0 时没有。 */
  firstMentionSeq?: number;
  /** 置顶（PRD-chat F-CVS-01，C5）：没有置顶时不带；老服务端没有，按 false。 */
  pinned?: boolean;
  /** 置顶时间，只在 pinned=true 时有；置顶的会话按它倒序排在最前（F-CVS-01 规则 3）。 */
  pinnedAt?: number;
  /** 免打扰（F-CVS-02，C5）：不推送、未读照常计算。没有免打扰时不带；老服务端没有，按 false。不叫 muted（那是禁言）。 */
  notifyOff?: boolean;
}

/** convs 的 deleted 一项（F-CVS-03 规则 6，C5）：被我删除且之后没有新消息的会话。 */
export interface DeletedConv {
  convId: string;
  clearedSeq: number;
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
  /** 当前被我删除、没有新消息的会话（C5）：消失的群先查它，在里面的不是"你已不在该群"。老服务端没有。 */
  deleted?: DeletedConv[];
  /** deleted 超过上限被截断（C5）：这时和 truncated 一样不推断"你已不在该群"（frontend-chat 第 54 条）。 */
  deletedTruncated?: boolean;
}

/** convSet 的 ack（C5）：完整的新会话。 */
export interface ConvSetAck {
  conv: ServerConversation;
}

/** convDelete 的 ack（C5）：min(upToSeq, maxSeq)，不小于原有值。 */
export interface ConvDeleteAck {
  clearedSeq: number;
}

/** 举报对象（PRD-chat F-MOD-03，C6）。 */
export type ReportTargetType = 'message' | 'user' | 'group';
/** 举报理由（F-MOD-03 规则 1）。界面文案见 frontend-chat 第 78 条。 */
export type ReportReason = 'spam' | 'abuse' | 'porn' | 'fraud' | 'illegal' | 'other';
export const REPORT_REASONS: readonly ReportReason[] = ['spam', 'abuse', 'porn', 'fraud', 'illegal', 'other'];

/**
 * report 命令的 data（frame.schema.json 的 ReportReq）：按 targetType 互斥。
 * message 带 convId（单聊或群聊）和同一会话的 msgIds；user 带 userId；group 带 groupId。
 */
export interface ReportReq {
  targetType: ReportTargetType;
  convId?: string;
  msgIds?: string[];
  userId?: string;
  groupId?: string;
  reason: ReportReason;
  note?: string;
}

/** report 的 ack（C6）：24 小时内对同一对象重复提交返回第一次的 reportId。 */
export interface ReportAck {
  reportId: string;
}

export interface AuthAck {
  userId: string;
  serverTime: number;
  /** 用户级禁言时才有，永久为 null（第二批）。 */
  mutedUntil?: number | null;
  /** 账号最新一代恢复码没有确认时才有（PRD-chat F-ACC-05 规则 1）：App 要强制进保存页。 */
  recoveryCodeUnacked?: boolean;
}

export type ServerEvent =
  | { type: 'kicked'; reason: string; until?: number | null; recoverBefore?: number }
  | { type: 'securityNotice'; kind: string; at: number; platform: Platform }
  | { type: 'msgDeleted'; convId: string; msgIds: string[]; seqs: number[]; recalled?: { by: string; at: number } }
  | { type: 'muted'; scope: string; groupId?: string; mutedUntil: number | null }
  | { type: 'unmuted'; scope: string; groupId?: string }
  | { type: 'convAdded'; conv: ServerConversation }
  | { type: 'convRemoved'; convId: string; reason?: string }
  | { type: 'readUpdated'; convId: string; readSeq: number }
  | { type: 'groupChanged'; groupId: string }
  | { type: 'socialChanged'; ver: number }
  | { type: 'socialSettingsChanged'; mode: 'open' | 'friends'; strangerMsgLimit: number }
  /** 同一用户的另一条连接改了置顶、免打扰（F-CVS-04 规则 1，C5）。pinnedAt 只在 pinned=true 时有。 */
  | { type: 'convSettingsChanged'; convId: string; pinned: boolean; pinnedAt?: number; notifyOff: boolean }
  /** 同一用户的另一条连接删除了会话（C5）：已读到 clearedSeq、不再置顶、minSeq = clearedSeq + 1。 */
  | { type: 'convDeleted'; convId: string; clearedSeq: number };

/** 下行帧。 */
export interface InboundFrame {
  id?: string;
  cmd: string;
  data?: unknown;
  error?: {
    code: number;
    msg: string;
    userId?: string;
    reason?: string;
    details?: { userId?: string } & Record<string, unknown>;
  };
}

/** 单聊会话 ID：c2c:{较小 userId}:{较大 userId}，按 ASCII 字节序比较（与服务端一致）。 */
export function c2cConvId(a: string, b: string): string {
  return a < b ? `c2c:${a}:${b}` : `c2c:${b}:${a}`;
}

export function groupConvId(groupId: string): string {
  return `group:${groupId}`;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** userId、groupId、msgId 的字符集（frame.schema.json 的 UserId 等）。 */
export function isValidId(s: unknown): s is string {
  return typeof s === 'string' && ID_RE.test(s);
}

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
 * 单聊必须恰好三段、两个 userId 合法且按 ASCII 字节序递增（相同时只能是 self 自己），其中一个是 self；群必须恰好两段且 groupId 合法；
 * 一期没有聊天室，room 和其他前缀一律不合法。
 */
export function parseConvIdStrict(convId: string, self: string): { convType: 'c2c' | 'group'; to: string } {
  const parts = convId.split(':');
  if (parts[0] === 'c2c' && parts.length === 3) {
    const [, a, b] = parts as [string, string, string];
    if (!ID_RE.test(a) || !ID_RE.test(b) || a > b) throw new ConvIdError('invalid', convId);
    // 两个 ID 相同只能是给自己发消息（F-MSG-01 规则 4、AC-UI-05-3，勘误 E-23）。
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
