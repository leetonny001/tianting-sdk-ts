import type {
  ConvType,
  GroupRole,
  LastMsg,
  MsgBody,
  MsgType,
  QuoteView,
  ServerConversation,
  ServerMessage,
} from './protocol.js';
import { countCodePoints } from './text.js';

/**
 * 发送状态（PRD F-MSG-03；附件见 PRD-chat F-FILE-07）。服务端来的消息都是 sent。
 * 附件：processing（App 在处理图片）→ uploading（申请、PUT、complete）→ queued（待发送：已 complete，等连接）→ sending → sent；
 * 任何一步可以转 failed。文本没有前两种。
 */
export type MessageStatus = 'processing' | 'uploading' | 'queued' | 'sending' | 'sent' | 'failed';

/**
 * 发送失败的原因：服务端错误码（4292 上传额度用完、4290 + errorReason=uploadPendingLimit、4139、4150、4096、5032…），
 * 或者 timeout（10 秒没有 ack）、kicked（被踢）、network（上传时网络或对象存储出错）、
 * process（App 处理图片失败：提示"无法处理这张图片，请用文件方式发送"）、
 * sourceMissing（要重新上传但原文件已不在：提示"原文件已不可用，请重新选择"）。
 */
export type MessageError = number | 'timeout' | 'kicked' | 'network' | 'process' | 'sourceMissing';

/** 界面看到的一条消息。待发 / 失败的消息还没有 msgId 和 seq。 */
export interface Message {
  clientMsgId: string;
  msgId?: string;
  seq?: number;
  convId: string;
  from: string;
  type: MsgType;
  body: MsgBody;
  /** 服务端时间；待发消息用本地时间临时展示（PRD 3.1）。 */
  ts: number;
  status: MessageStatus;
  /** 发送失败的原因，见 MessageError。 */
  error?: MessageError;
  /** 错误码的 reason（例如 4290 的 uploadPendingLimit）。 */
  errorReason?: string;
  /** 被删除（PRD-admin F-ADM-31）或撤回：seq、msgId、发送者、时间都保留，body 为空对象。 */
  deleted?: boolean;
  deletedAt?: number;
  /** 被撤回（PRD-chat F-RCL-01 规则 5a）：同时 deleted=true。文案用 recallNotice / recallText。 */
  recalled?: boolean;
  recalledAt?: number;
  /** 撤回的操作者；老服务端或本地推断不出来时为空。 */
  recalledBy?: string;
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
  /** 群成员数；字段缺失时为 undefined（界面只显示群名，不显示 0）。 */
  memberCount?: number;
  /** 群里我的角色（M4）；单聊和旧服务端没有。 */
  myRole?: GroupRole;
  /** 已有消息展示内容的版本号（F-RCL-03 规则 2）；老服务端没有。 */
  modVer?: number;
  /** 未读中提及我的数量（F-MEN-03 规则 1）：大于 0 时列表摘要前缀"[有人@我]"。服务端没给时为 undefined。 */
  mentionUnread?: number;
  /** 未读里第一条提及我的 seq（"有人@我"跳转按钮）。 */
  firstMentionSeq?: number;
}

/**
 * 被移出群后保留的会话快照（PRD-ui G-UI-21）：会话从列表里消失，但聊天页还能显示群名和"你已不在该群"。
 * 保留到本次登录结束；reason 透传服务端的值（removed / dissolved / left / 不认识的值，或推断出来的没有 reason）。
 */
export interface ConversationSnapshot {
  convId: string;
  type: ConvType;
  name: string;
  removed: true;
  reason?: string;
}

interface ConvState extends Conversation {
  /** 计算未读的基线 = max(readSeq, joinSeq)：同步时由服务端的 maxSeq − unread 得到（C-02）。 */
  readBase: number;
}

const SUMMARY_LEN = 100;

/** 撤回的信息（msgDeleted 的 recalled，或 sync 下发的 recalled、recalledBy、recalledAt）。by 为空表示不知道是谁。 */
export interface RecallInfo {
  by: string;
  at?: number;
}

/** 被删除的最后一条消息的摘要：不保留原文。撤回时带 recalled、recalledBy（F-RCL-03 规则 4）。 */
function deletedLast(m: { msgId: string; from: string; type: string; ts: number }, recall?: RecallInfo): LastMsg {
  const out: LastMsg = { msgId: m.msgId, from: m.from, type: m.type, ts: m.ts, deleted: true };
  if (recall) {
    out.recalled = true;
    if (recall.by) out.recalledBy = recall.by;
  }
  return out;
}

function recallOf(m: { recalled?: boolean; recalledBy?: string; recalledAt?: number }): RecallInfo | undefined {
  if (m.recalled !== true) return undefined;
  const r: RecallInfo = { by: m.recalledBy ?? '' };
  if (m.recalledAt !== undefined) r.at = m.recalledAt;
  return r;
}

/** 引用清除原文（F-QUO-02 规则 4）：只留定位用的 msgId、seq、from、type 和新状态。 */
function clearedQuote(q: QuoteView, state: string): QuoteView {
  const out: QuoteView = { msgId: q.msgId, state };
  if (q.seq !== undefined) out.seq = q.seq;
  if (q.from !== undefined) out.from = q.from;
  if (q.type !== undefined) out.type = q.type;
  return out;
}

/** 图片或文件已过期（F-FILE-06 规则 3）。 */
export function fileExpired(body: MsgBody | undefined): boolean {
  return body?.image?.expired === true || body?.file?.expired === true;
}

/** 过期后的内容：标记 expired，文件名清空（服务端同样清空，F-FILE-06 规则 3）。 */
function expireBody(body: MsgBody): MsgBody {
  if (body.image) return { ...body, image: { ...body.image, expired: true } };
  if (body.file) return { ...body, file: { ...body.file, expired: true, name: '' } };
  return body;
}

function summary(text: string): string {
  if (countCodePoints(text) <= SUMMARY_LEN) return text;
  return Array.from(text).slice(0, SUMMARY_LEN).join('');
}

/** 删除或撤回后的消息：只留定位和展示需要的字段，正文、文件名、引用都清掉（F-RCL-03 规则 3）。 */
function deletedMessage(
  m: Pick<Message, 'clientMsgId' | 'convId' | 'from' | 'type' | 'ts'> & { msgId?: string; seq?: number },
  deletedAt?: number,
  recall?: RecallInfo,
): Message {
  const out: Message = {
    clientMsgId: m.clientMsgId,
    convId: m.convId,
    from: m.from,
    type: m.type,
    body: {},
    ts: m.ts,
    status: 'sent',
    deleted: true,
  };
  if (m.msgId !== undefined) out.msgId = m.msgId;
  if (m.seq !== undefined) out.seq = m.seq;
  if (deletedAt !== undefined) out.deletedAt = deletedAt;
  return recall ? withRecall(out, recall) : out;
}

function withRecall(m: Message, recall: RecallInfo): Message {
  const out: Message = { ...m, recalled: true };
  if (recall.by) out.recalledBy = recall.by;
  if (recall.at !== undefined) out.recalledAt = recall.at;
  return out;
}

/** 一个会话的消息：有 seq 的按 seq 升序，没有 seq 的（待发 / 失败）按发送顺序排在最后（F-MSG-03 规则 3）。 */
class MessageList {
  private bySeq = new Map<number, Message>();
  private unsent: Message[] = [];
  private byClient = new Map<string, Message>();
  private byMsgId = new Set<string>();
  // 已知被删除的 msgId / seq：之后才到的 sync 结果、发送 ack 带着原文也不能写回来。值是撤回信息（后台删除为 undefined）。
  private deletedIds = new Map<string, RecallInfo | undefined>();
  private deletedSeqs = new Map<number, RecallInfo | undefined>();
  // 已知文件已过期的 msgId（F-FILE-06 规则 3）：expired 只能从假变真，迟到的旧 sync 不能把它改回去（F-RCL-03 规则 2a）。
  private expiredIds = new Set<string>();
  /** 这次合并里刚变成过期的 fileId，由 Store 取走（清缓存用）。 */
  newlyExpired: string[] = [];
  /** 其中因撤回而失效的 fileId（newlyExpired 的子集）：取地址中的下载要中止并告诉页面是撤回（AC-RCL-03-12，问题 33）。 */
  newlyRecalled: string[] = [];
  // 本地删除过的失败消息（G-UI-14）：它可能其实到了服务端，之后的 ack、sync 不能让它再出现。
  /** 用户删掉的失败消息：clientMsgId → 发送者。clientMsgId 只在同一发送者内唯一，别人用同样的值不能被拦。 */
  private removedClient = new Map<string, string>();
  /** 已加载的最早 seq（用于向前翻页）；0 表示还没加载过。 */
  oldestSeq = 0;
  /** 向前翻页是否还有更早的消息。 */
  hasMoreHistory = true;

  /**
   * 合并服务端消息；按 msgId 去重，按 clientMsgId 合并本地待发消息。
   * 已有的消息单调合并（F-RCL-03 规则 2a）：deleted、recalled、文件的 expired 只能从假变真，deletedIds 优先；
   * quote.state 只能从 normal 往后走，quote.text 清除后不恢复；迟到的旧 sync 应答带着原文、expired=false、
   * deleted=false 或 quote.state=normal 时不回写。返回合并后的消息，没有变化时为 null。
   */
  addServer(m: ServerMessage): Message | null {
    if (this.removedClient.get(m.clientMsgId) === m.from) return null;
    const deleted = m.deleted === true || this.isDeleted(m.msgId, m.seq);
    const recall = recallOf(m) ?? this.recallOf(m.msgId, m.seq);
    if (this.byMsgId.has(m.msgId)) {
      const old = this.bySeq.get(m.seq);
      if (!old) return null;
      if (old.deleted) {
        // 已删除的只接受"后台删除 → 撤回"的补充信息（recalled 从假变真），正文不会回来。
        if (!recall || old.recalled) return null;
        return this.replace(old, withRecall(old, recall));
      }
      if (deleted) return this.wipe(old, m.deletedAt, recall);
      let body = old.body;
      if (fileExpired(m.body) && !fileExpired(old.body)) {
        this.expiredIds.add(m.msgId);
        body = expireBody(body);
      }
      const q = old.body.quote;
      const nq = m.body?.quote;
      if (q && q.state === 'normal' && nq && nq.state !== 'normal')
        body = { ...body, quote: clearedQuote(q, nq.state) };
      return body === old.body ? null : this.replace(old, { ...old, body });
    }
    const local = this.byClient.get(m.clientMsgId);
    if (local && local.seq === undefined && local.from === m.from) {
      this.unsent = this.unsent.filter((x) => x !== local);
    }
    let body = m.body ?? {};
    if (!deleted && (fileExpired(body) || this.expiredIds.has(m.msgId))) {
      if (!this.expiredIds.has(m.msgId)) this.noteExpired(body);
      this.expiredIds.add(m.msgId);
      body = expireBody(body);
    }
    // 引用的消息本地已知被撤回或删除：这份应答可能是撤回之前生成的，引用原文不能写进来（AC-RCL-03-13）。
    const gone = body.quote?.state === 'normal' ? this.goneState(body.quote.msgId, body.quote.seq) : undefined;
    if (gone && body.quote) body = { ...body, quote: clearedQuote(body.quote, gone) };
    const msg: Message = deleted ? deletedMessage(m, m.deletedAt, recall) : { ...m, body, status: 'sent' };
    this.bySeq.set(m.seq, msg);
    this.byClient.set(m.clientMsgId, msg);
    this.byMsgId.add(m.msgId);
    if (this.oldestSeq === 0 || m.seq < this.oldestSeq) this.oldestSeq = m.seq;
    return msg;
  }

  isDeleted(msgId: string, seq?: number): boolean {
    return this.deletedIds.has(msgId) || (seq !== undefined && this.deletedSeqs.has(seq));
  }

  /** 本地已知的撤回信息（只有撤回的有，后台删除的没有）。 */
  recallOf(msgId: string, seq?: number): RecallInfo | undefined {
    return this.deletedIds.get(msgId) ?? (seq !== undefined ? this.deletedSeqs.get(seq) : undefined);
  }

  /** 引用这条消息的 quote 应有的状态：已知撤回为 recalled，已知删除为 deleted，其他为 undefined。 */
  private goneState(msgId: string, seq?: number): 'recalled' | 'deleted' | undefined {
    if (!this.isDeleted(msgId, seq)) return undefined;
    return this.recallOf(msgId, seq) ? 'recalled' : 'deleted';
  }

  /**
   * 记下被删除（recall 不为空时是撤回）的消息并清掉已加载的原文；本会话里引用这几条的消息（含待发的）清除引用原文，
   * 状态改成 recalled 或 deleted（F-QUO-02 规则 4）。撤回信息只增不减：已经知道是撤回的，之后的后台删除不改回去。
   * 返回是否有消息变了。
   */
  markDeleted(msgIds: readonly string[], seqs: readonly number[], recall?: RecallInfo): boolean {
    for (const id of msgIds) this.deletedIds.set(id, recall ?? this.deletedIds.get(id));
    for (const s of seqs) this.deletedSeqs.set(s, recall ?? this.deletedSeqs.get(s));
    let changed = false;
    for (const m of [...this.bySeq.values()]) {
      if (!this.isDeleted(m.msgId ?? '', m.seq)) continue;
      const r = this.recallOf(m.msgId ?? '', m.seq);
      if (!m.deleted) {
        this.wipe(m, undefined, r);
        changed = true;
      } else if (r && !m.recalled) {
        this.replace(m, withRecall(m, r));
        changed = true;
      }
    }
    for (const m of [...this.bySeq.values(), ...this.unsent]) {
      const q = m.body.quote;
      if (!q || q.state !== 'normal') continue;
      const gone = this.goneState(q.msgId, q.seq);
      if (!gone) continue;
      const body = { ...m.body, quote: clearedQuote(q, gone) };
      if (m.seq !== undefined) this.replace(m, { ...m, body });
      else this.update(m.clientMsgId, { body });
      changed = true;
    }
    return changed;
  }

  /** 按 msgId 找已加载的消息（引用、撤回用）。 */
  findByMsgId(msgId: string): Message | undefined {
    if (!this.byMsgId.has(msgId)) return undefined;
    for (const m of this.bySeq.values()) if (m.msgId === msgId) return m;
    return undefined;
  }

  private wipe(old: Message, deletedAt?: number, recall?: RecallInfo): Message {
    this.noteExpired(old.body); // 文件的缓存同样要清（F-RCL-03 规则 3）
    const id = old.body.image?.fileId || old.body.file?.fileId;
    if (recall && id && !this.newlyRecalled.includes(id)) this.newlyRecalled.push(id);
    return this.replace(old, deletedMessage(old, deletedAt ?? old.deletedAt, recall));
  }

  private replace(old: Message, next: Message): Message {
    if (next.body !== old.body && fileExpired(next.body)) this.noteExpired(old.body);
    this.bySeq.set(old.seq!, next);
    this.byClient.set(old.clientMsgId, next);
    return next;
  }

  private noteExpired(body: MsgBody): void {
    const id = body.image?.fileId || body.file?.fileId;
    if (id && !this.newlyExpired.includes(id)) this.newlyExpired.push(id);
  }

  /** 是否有还没有 seq 的本地消息（待发 / 失败），它们可能正是服务端已经存下的某一条。 */
  get hasUnsent(): boolean {
    return this.unsent.length > 0;
  }

  /** 调试导出：这个会话内存里的全部消息副本（AC-ADM-31-3）。 */
  debugAll(): Message[] {
    return [...new Set([...this.bySeq.values(), ...this.unsent, ...this.byClient.values()])];
  }

  addLocal(m: Message): void {
    this.unsent.push(m);
    this.byClient.set(m.clientMsgId, m);
  }

  local(clientMsgId: string): Message | undefined {
    return this.byClient.get(clientMsgId);
  }

  /** 移除一条失败的本地消息，并记住它的 clientMsgId。不是失败状态时不动，返回 false。 */
  removeFailed(clientMsgId: string): boolean {
    return this.removeUnsent(clientMsgId, ['failed']);
  }

  /** 移除一条还没有 seq、状态在 statuses 里的本地消息（取消上传，F-FILE-07、AC-FILE-02-5），并记住 clientMsgId。 */
  removeUnsent(clientMsgId: string, statuses: readonly MessageStatus[]): boolean {
    const m = this.byClient.get(clientMsgId);
    if (!m || !statuses.includes(m.status) || m.seq !== undefined) return false;
    this.unsent = this.unsent.filter((x) => x !== m);
    this.byClient.delete(clientMsgId);
    this.removedClient.set(clientMsgId, m.from);
    return true;
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

  /** 还在进行中的本地消息（处理、上传、排队、发送中）。 */
  pendingMessages(): Message[] {
    return this.unsent.filter((m) => m.status !== 'failed' && m.status !== 'sent');
  }

  snapshot(): Message[] {
    return [...[...this.bySeq.values()].sort((a, b) => a.seq! - b.seq!), ...this.unsent];
  }

  hasExpiredFile(fileId: string): boolean {
    for (const m of this.bySeq.values()) {
      if ((m.body.image?.fileId === fileId || m.body.file?.fileId === fileId) && fileExpired(m.body)) return true;
    }
    return false;
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

  /**
   * 用服务端的会话列表覆盖本地（convs 的结果）。返回推断为"被移出"的群：原来在、新列表里没有的群会话
   * （服务端不为离线期间的移出补发 convRemoved，G-UI-21 ②）。列表被截断时不推断，单聊不推断。
   */
  setConversations(list: ServerConversation[], truncated = false): string[] {
    const next = new Map<string, ConvState>();
    for (const c of list) next.set(c.convId, this.fromServer(c));
    const gone: string[] = [];
    if (!truncated) {
      for (const [id, c] of this.convs) {
        if (c.type === 'group' && !next.has(id) && !this.placeholders.has(id)) {
          this.snapshots.set(id, { convId: id, type: c.type, name: c.name, removed: true });
          gone.push(id);
        }
      }
    }
    for (const id of next.keys()) this.snapshots.delete(id);
    this.convs = next;
    this.placeholders.clear();
    this.truncated = truncated;
    return gone;
  }

  /** 最近一次 convs 是否被截断（超过 500 个会话，C-03）。 */
  truncated = false;

  upsertConversation(c: ServerConversation): void {
    this.convs.set(c.convId, this.fromServer(c));
    this.placeholders.delete(c.convId);
    this.snapshots.delete(c.convId); // 重新被拉进群：清除快照（G-UI-21 ③）
  }

  /** 被移出群：从列表移除并保留快照。 */
  removeConversation(convId: string, reason?: string): void {
    const c = this.convs.get(convId);
    const snap: ConversationSnapshot = {
      convId,
      type: c?.type ?? (convId.startsWith('group:') ? 'group' : 'c2c'),
      name: c?.name ?? convId.slice(convId.indexOf(':') + 1),
      removed: true,
    };
    if (reason !== undefined) snap.reason = reason;
    this.snapshots.set(convId, snap);
    this.convs.delete(convId);
  }

  private snapshots = new Map<string, ConversationSnapshot>();

  snapshot(convId: string): ConversationSnapshot | undefined {
    return this.snapshots.get(convId);
  }

  conversation(convId: string): Conversation | undefined {
    return this.convs.get(convId);
  }

  /**
   * 按 updatedAt 倒序、convId 升序（与服务端一致）。
   * 快照引用稳定（G-UI-19）：没有变化的会话返回同一个对象，整体没有变化时返回同一个数组，界面可以按引用比较。
   */
  conversations(): Conversation[] {
    const sorted = [...this.convs.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || (a.convId < b.convId ? -1 : a.convId > b.convId ? 1 : 0),
    );
    const prev = this.views;
    const views = new Map<string, Conversation>();
    let same = this.lastList !== null && this.lastList.length === sorted.length;
    const list = sorted.map(({ readBase: _, ...c }, i) => {
      const old = prev.get(c.convId);
      const v = old && sameConversation(old, c) ? old : c;
      views.set(c.convId, v);
      if (same && this.lastList![i] !== v) same = false;
      return v;
    });
    this.views = views;
    if (same) return this.lastList!;
    this.lastList = list;
    return list;
  }

  private views = new Map<string, Conversation>();
  private lastList: Conversation[] | null = null;

  private fromServer(c: ServerConversation): ConvState {
    const { mutedUntil: _, allMuted: __, ...rest } = c; // 禁言状态由 IMClient 的 MuteTable 维护，事件和到期都会改它
    const last = c.lastMsg;
    // 这份 convs 可能是删除之前生成的：已知被删除的消息不能把原文带回摘要；已知是撤回的，摘要也保持撤回（只能从假变真）。
    const list = this.msgs.get(c.convId);
    let lastMsg = last;
    if (last && list?.isDeleted(last.msgId) && (!last.deleted || !last.recalled)) {
      const recall = list.recallOf(last.msgId);
      if (!last.deleted || recall) lastMsg = deletedLast(last, recall);
    }
    return { ...rest, lastMsg, readBase: c.maxSeq - c.unread };
  }

  /** 已读位置前进（自己上报、其他端同步、发言即已读），只进不退。 */
  advanceRead(convId: string, seq: number): boolean {
    const c = this.convs.get(convId);
    if (!c || seq <= c.readSeq) return false;
    c.readSeq = seq;
    this.recount(c);
    return true;
  }

  /** 本端已读到最新：提及我的未读也清零（F-MEN-03 规则 1"已读前进后减少"），跳转按钮消失。 */
  clearMentions(convId: string): boolean {
    const c = this.convs.get(convId);
    if (!c?.mentionUnread || c.readSeq < c.maxSeq) return false;
    c.mentionUnread = 0;
    delete c.firstMentionSeq;
    return true;
  }

  /** 实时收到一条提及我的未读消息：本地先加 1，下次 convs 时以服务端为准（AC-MEN-01-1）。服务端没给过计数的会话不推算。 */
  bumpMention(convId: string, seq: number): boolean {
    const c = this.convs.get(convId);
    if (!c || c.mentionUnread === undefined || seq <= c.readSeq) return false;
    c.mentionUnread += 1;
    if (!c.firstMentionSeq || seq < c.firstMentionSeq) c.firstMentionSeq = seq;
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

  /** 有消息列表的会话（可能还不在会话列表里）。 */
  messageConvIds(): string[] {
    return [...this.msgs.keys()];
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
    const merged = this.list(m.convId).addServer(m);
    this.bumpMax(m.convId, m.seq);
    if (!merged) return false;
    const c = this.convs.get(m.convId) ?? this.newConversation(m);
    const recall = merged.recalled ? { by: merged.recalledBy ?? '' } : undefined;
    if (m.seq > c.maxSeq) {
      c.maxSeq = m.seq;
      c.lastMsg = merged.deleted
        ? deletedLast(m, recall)
        : { msgId: m.msgId, from: m.from, type: m.type, text: summary(merged.body.text ?? ''), ts: m.ts };
      c.updatedAt = Math.max(c.updatedAt, m.ts);
    } else if (
      merged.deleted &&
      c.lastMsg?.msgId === m.msgId &&
      (!c.lastMsg.deleted || (recall && !c.lastMsg.recalled))
    ) {
      c.lastMsg = deletedLast(c.lastMsg, recall);
    }
    if (m.from === this.self()) c.readSeq = Math.max(c.readSeq, m.seq);
    this.recount(c);
    return true;
  }

  /**
   * 消息被删除或撤回（msgDeleted，或 convs 的 lastMsg.deleted）：清除原文和引用它的原文，摘要改成占位。
   * seq 不留空洞，未读不变、updatedAt 不变（C-02，F-RCL-01 规则 6）。recall 不为空表示撤回。
   * 没加载过的消息也记下来，之后到的 sync 结果、发送 ack 不会把原文写回来。返回消息列表是否有变化。
   */
  deleteMessages(convId: string, msgIds: readonly string[], seqs: readonly number[], recall?: RecallInfo): boolean {
    const changed = this.list(convId).markDeleted(msgIds, seqs, recall);
    const c = this.convs.get(convId);
    const last = c?.lastMsg;
    if (c && last && (msgIds.includes(last.msgId) || seqs.includes(c.maxSeq))) {
      if (!last.deleted || (recall && !last.recalled)) c.lastMsg = deletedLast(last, recall);
    }
    return changed;
  }

  /** 取走刚因撤回失效的文件的 fileId（takeExpiredFiles 的子集，要先取）。 */
  takeRecalledFiles(): Set<string> {
    const out = new Set<string>();
    for (const l of this.msgs.values()) {
      for (const id of l.newlyRecalled) out.add(id);
      l.newlyRecalled = [];
    }
    return out;
  }

  /** 取走合并时刚变成过期（或被删除）的文件的 fileId：调用方清地址和文件缓存（F-FILE-06 规则 3、AC-FILE-06-12）。 */
  takeExpiredFiles(): string[] {
    const out: string[] = [];
    for (const l of this.msgs.values()) {
      out.push(...l.newlyExpired);
      l.newlyExpired = [];
    }
    return out;
  }

  /** 这条消息的文件是否已知过期（申请地址前看一眼，AC-FILE-06-6：不发申请地址的请求）。 */
  fileExpired(fileId: string): boolean {
    for (const l of this.msgs.values()) if (l.hasExpiredFile(fileId)) return true;
    return false;
  }

  /** 已加载过服务端消息的会话和已加载的 seq 范围。 */
  loadedRanges(): Array<{ convId: string; from: number; to: number }> {
    const out: Array<{ convId: string; from: number; to: number }> = [];
    for (const [convId, l] of this.msgs) {
      if (l.oldestSeq > 0) out.push({ convId, from: l.oldestSeq, to: l.maxLoadedSeq });
    }
    return out;
  }

  /** 调试导出：内存里的会话和全部消息副本（AC-ADM-31-3）。 */
  debugExport(): { conversations: unknown[]; messages: Record<string, Message[]> } {
    const messages: Record<string, Message[]> = {};
    for (const [convId, l] of this.msgs) messages[convId] = l.debugAll();
    return { conversations: [...this.convs.values(), ...this.snapshots.values()], messages };
  }

  bumpMax(convId: string, seq: number): void {
    if (seq > this.maxSeq(convId)) this.localMax.set(convId, seq);
  }

  /** 是否有本地临时补的会话（服务端会话列表里还没有）：调用方应该尽快重新拉取 convs。 */
  hasPlaceholder(convId: string): boolean {
    return this.placeholders.has(convId);
  }

  private placeholders = new Set<string>();

  setLastMsgText(convId: string, msgId: string, text: string): void {
    const c = this.convs.get(convId);
    if (c?.lastMsg?.msgId === msgId && !c.lastMsg.deleted) c.lastMsg.text = summary(text);
  }

  /** groupChanged 之后用 groupInfo 的结果更新本地会话（F-SOC-20 规则 5）。返回是否有变化。 */
  updateGroupMeta(convId: string, meta: { name: string; memberCount: number; myRole: GroupRole }): boolean {
    const c = this.convs.get(convId);
    if (!c || (c.name === meta.name && c.memberCount === meta.memberCount && c.myRole === meta.myRole)) return false;
    Object.assign(c, meta);
    return true;
  }

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

function sameLast(a: LastMsg | null, b: LastMsg | null): boolean {
  if (a === b) return true;
  return (
    !!a &&
    !!b &&
    a.msgId === b.msgId &&
    a.ts === b.ts &&
    a.text === b.text &&
    a.from === b.from &&
    a.type === b.type &&
    a.deleted === b.deleted &&
    a.recalled === b.recalled &&
    a.recalledBy === b.recalledBy
  );
}

function sameConversation(a: Conversation, b: Conversation): boolean {
  return (
    a.convId === b.convId &&
    a.type === b.type &&
    a.name === b.name &&
    a.maxSeq === b.maxSeq &&
    a.readSeq === b.readSeq &&
    a.minSeq === b.minSeq &&
    a.unread === b.unread &&
    a.updatedAt === b.updatedAt &&
    a.memberCount === b.memberCount &&
    a.myRole === b.myRole &&
    a.mentionUnread === b.mentionUnread &&
    a.firstMentionSeq === b.firstMentionSeq &&
    sameLast(a.lastMsg, b.lastMsg)
  );
}
