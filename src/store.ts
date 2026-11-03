import type { ConvType, LastMsg, MsgBody, ServerConversation, ServerMessage } from './protocol.js';
import { countCodePoints } from './text.js';

/** 发送状态（PRD F-MSG-03）。queued：离线时进入待发队列；服务端来的消息都是 sent。 */
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed';

/** 界面看到的一条消息。待发 / 失败的消息还没有 msgId 和 seq。 */
export interface Message {
  clientMsgId: string;
  msgId?: string;
  seq?: number;
  convId: string;
  from: string;
  type: 'text' | 'custom';
  body: MsgBody;
  /** 服务端时间；待发消息用本地时间临时展示（PRD 3.1）。 */
  ts: number;
  status: MessageStatus;
  /** 发送失败的原因：错误码，或 "timeout" / "kicked"。 */
  error?: number | 'timeout' | 'kicked';
}

/** 界面看到的一个会话。 */
export interface Conversation {
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

interface ConvState extends Conversation {
  /** 计算未读的基线 = max(readSeq, joinSeq)：同步时由服务端的 maxSeq − unread 得到（C-02）。 */
  readBase: number;
}

const SUMMARY_LEN = 100;

function summary(text: string): string {
  if (countCodePoints(text) <= SUMMARY_LEN) return text;
  return Array.from(text).slice(0, SUMMARY_LEN).join('');
}

/** 一个会话的消息：有 seq 的按 seq 升序，没有 seq 的（待发 / 失败）按发送顺序排在最后（F-MSG-03 规则 3）。 */
class MessageList {
  private bySeq = new Map<number, Message>();
  private unsent: Message[] = [];
  private byClient = new Map<string, Message>();
  private byMsgId = new Set<string>();
  /** 已加载的最早 seq（用于向前翻页）；0 表示还没加载过。 */
  oldestSeq = 0;
  /** 向前翻页是否还有更早的消息。 */
  hasMoreHistory = true;

  /** 合并服务端消息；按 msgId 去重，按 clientMsgId 合并本地待发消息。返回是否有变化。 */
  addServer(m: ServerMessage): boolean {
    if (this.byMsgId.has(m.msgId)) return false;
    const local = this.byClient.get(m.clientMsgId);
    if (local && local.seq === undefined && local.from === m.from) {
      this.unsent = this.unsent.filter((x) => x !== local);
    }
    const msg: Message = { ...m, status: 'sent' };
    this.bySeq.set(m.seq, msg);
    this.byClient.set(m.clientMsgId, msg);
    this.byMsgId.add(m.msgId);
    if (this.oldestSeq === 0 || m.seq < this.oldestSeq) this.oldestSeq = m.seq;
    return true;
  }

  addLocal(m: Message): void {
    this.unsent.push(m);
    this.byClient.set(m.clientMsgId, m);
  }

  local(clientMsgId: string): Message | undefined {
    return this.byClient.get(clientMsgId);
  }

  has(seq: number): boolean {
    return this.bySeq.has(seq);
  }

  /** 更新本地消息（状态变化）；返回新对象，旧对象保持不变，方便界面按引用比较。 */
  update(clientMsgId: string, patch: Partial<Message>): Message | undefined {
    const old = this.byClient.get(clientMsgId);
    if (!old) return undefined;
    const next = { ...old, ...patch };
    this.byClient.set(clientMsgId, next);
    this.unsent = this.unsent.map((x) => (x === old ? next : x));
    if (old.seq !== undefined) this.bySeq.set(old.seq, next);
    return next;
  }

  /** 清空已加载的服务端消息（缺口超过 200 条时只保留最新一页，C-24），保留待发 / 失败的消息。 */
  resetServer(): void {
    for (const m of this.bySeq.values()) this.byClient.delete(m.clientMsgId);
    this.bySeq.clear();
    this.byMsgId.clear();
    this.oldestSeq = 0;
    this.hasMoreHistory = true;
  }

  pendingMessages(): Message[] {
    return this.unsent.filter((m) => m.status === 'queued' || m.status === 'sending');
  }

  snapshot(): Message[] {
    return [...[...this.bySeq.values()].sort((a, b) => a.seq! - b.seq!), ...this.unsent];
  }

  get maxLoadedSeq(): number {
    let max = 0;
    for (const s of this.bySeq.keys()) max = Math.max(max, s);
    return max;
  }
}

/** 本地数据：会话列表和每个会话的消息（FE-004 的数据部分）。只在内存里（D4）。 */
export class Store {
  private convs = new Map<string, ConvState>();
  private msgs = new Map<string, MessageList>();
  /** 每个会话本地已经知道的最大 seq（收到的消息、ack 带回的 seq 都计入）。 */
  private localMax = new Map<string, number>();

  constructor(private readonly self: () => string) {}

  // ---- 会话 ----

  /** 用服务端的会话列表覆盖本地（convs 的结果）。 */
  setConversations(list: ServerConversation[]): void {
    const next = new Map<string, ConvState>();
    for (const c of list) next.set(c.convId, this.fromServer(c));
    this.convs = next;
    this.placeholders.clear();
  }

  upsertConversation(c: ServerConversation): void {
    this.convs.set(c.convId, this.fromServer(c));
    this.placeholders.delete(c.convId);
  }

  removeConversation(convId: string): void {
    this.convs.delete(convId);
  }

  conversation(convId: string): Conversation | undefined {
    return this.convs.get(convId);
  }

  /** 按 updatedAt 倒序、convId 升序（与服务端一致）。 */
  conversations(): Conversation[] {
    return [...this.convs.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.convId < b.convId ? -1 : a.convId > b.convId ? 1 : 0))
      .map(({ readBase: _, ...c }) => c);
  }

  private fromServer(c: ServerConversation): ConvState {
    return { ...c, readBase: c.maxSeq - c.unread };
  }

  /** 已读位置前进（自己上报、其他端同步、发言即已读），只进不退。 */
  advanceRead(convId: string, seq: number): boolean {
    const c = this.convs.get(convId);
    if (!c || seq <= c.readSeq) return false;
    c.readSeq = seq;
    this.recount(c);
    return true;
  }

  private recount(c: ConvState): void {
    c.unread = Math.max(0, c.maxSeq - Math.max(c.readBase, c.readSeq));
  }

  // ---- 消息 ----

  list(convId: string): MessageList {
    let l = this.msgs.get(convId);
    if (!l) {
      l = new MessageList();
      this.msgs.set(convId, l);
    }
    return l;
  }

  messages(convId: string): Message[] {
    return this.msgs.get(convId)?.snapshot() ?? [];
  }

  maxSeq(convId: string): number {
    return this.localMax.get(convId) ?? 0;
  }

  /**
   * 合并一条服务端消息，并更新会话的 maxSeq、未读、最后一条消息。
   * 自己发的消息（来自自己的其他端）不增加未读，并推进已读（C-34）。返回是否是新消息。
   */
  applyServerMessage(m: ServerMessage): boolean {
    const added = this.list(m.convId).addServer(m);
    this.bumpMax(m.convId, m.seq);
    if (!added) return false;
    const c = this.convs.get(m.convId) ?? this.newConversation(m);
    if (m.seq > c.maxSeq) {
      c.maxSeq = m.seq;
      c.lastMsg = { msgId: m.msgId, from: m.from, type: m.type, text: summary(m.body.text ?? ''), ts: m.ts };
      c.updatedAt = Math.max(c.updatedAt, m.ts);
    }
    if (m.from === this.self()) c.readSeq = Math.max(c.readSeq, m.seq);
    this.recount(c);
    return true;
  }

  bumpMax(convId: string, seq: number): void {
    if (seq > this.maxSeq(convId)) this.localMax.set(convId, seq);
  }

  /** 是否有本地临时补的会话（服务端会话列表里还没有）：调用方应该尽快重新拉取 convs。 */
  hasPlaceholder(convId: string): boolean {
    return this.placeholders.has(convId);
  }

  private placeholders = new Set<string>();

  /** 第一次收到某个会话的消息、本地还没有这个会话时，先补一个临时的；重新拉取 convs 后被服务端数据覆盖。 */
  private newConversation(m: ServerMessage): ConvState {
    const [type, a = '', b = ''] = m.convId.split(':');
    const c: ConvState = {
      convId: m.convId,
      type: (type as ConvType) ?? 'c2c',
      name: type === 'c2c' ? (a === this.self() ? b : a) : a,
      maxSeq: 0,
      readSeq: 0,
      minSeq: 1,
      unread: 0,
      lastMsg: null,
      updatedAt: 0,
      readBase: 0,
    };
    this.convs.set(m.convId, c);
    this.placeholders.add(m.convId);
    return c;
  }
}
