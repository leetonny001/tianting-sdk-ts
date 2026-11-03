import { realClock, type Clock, type TimerHandle } from './clock.js';
import {
  Connection,
  ConnectionClosedError,
  DEFAULT_TIMINGS,
  NotConnectedError,
  TimeoutError,
  type ConnState,
  type FatalReason,
} from './connection.js';
import { Emitter } from './emitter.js';
import { IMError } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import {
  parseConvId,
  type AuthAck,
  type ConvsAck,
  type InboundFrame,
  type Platform,
  type SendAck,
  type ServerConversation,
  type ServerEvent,
  type ServerMessage,
  type SyncAck,
} from './protocol.js';
import { Store, type Conversation, type Message } from './store.js';
import { checkText, type TextCheck } from './text.js';
import { WebSocketTransport, type Transport } from './transport.js';

export interface IMClientTimings {
  heartbeatMs: number;
  pongTimeoutMs: number;
  requestTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  jitter: number;
  /** 发送超时（PRD F-MSG-03 规则 1）。 */
  sendTimeoutMs: number;
  /** 发现 seq 缺口后等多久还没补上就 sync（F-MSG-04 规则 2）。 */
  gapWaitMs: number;
  /** 已读上报节流（F-CONV-02 规则 3）。 */
  readThrottleMs: number;
  /** 断开持续多久才提示（F-CONN-02）。 */
  bannerDelayMs: number;
}

export interface IMClientOptions {
  /** WebSocket 地址，例如 wss://im.example.com/ws。 */
  url: string;
  platform?: Platform;
  /** 以下用于测试注入（FE-007）。 */
  transport?: Transport;
  clock?: Clock;
  random?: () => number;
  newId?: () => string;
  logger?: Logger;
  timings?: Partial<IMClientTimings>;
  /** 页面是否可见；默认读 document.visibilityState。 */
  isVisible?: () => boolean;
  /** 是否自动监听浏览器的 online / visibilitychange 事件（浏览器里默认开启）。 */
  browserEvents?: boolean;
}

const DEFAULTS: IMClientTimings = {
  ...DEFAULT_TIMINGS,
  sendTimeoutMs: 10_000,
  gapWaitMs: 500,
  readThrottleMs: 1_000,
  bannerDelayMs: 1_000,
};

/** 缺口超过这么多条时，只加载最新一页，更早的靠向上翻页（C-24）。 */
const MAX_CATCH_UP = 200;
const PAGE = 200;
const LATEST_PAGE = 20;

type ClientEvents = {
  /** 连接状态。 */
  state: [ConnState];
  /** 是否显示"连接中…/网络不可用"提示：断开持续超过 bannerDelayMs 才为 true，恢复后立即为 false。 */
  banner: [boolean];
  conversations: [Conversation[]];
  /** 某个会话的消息有变化。 */
  messages: [convId: string, messages: Message[]];
  /** 全部会话的未读总数有变化（与 conversations 同一轮发出，PRD-ui G-UI-15）。 */
  totalUnread: [number];
  /** 发送中 / 排队 / 失败的消息总数有变化（退出登录确认、离开页面提示用，G-UI-20）。 */
  pendingCount: [number];
  /**
   * 一条消息这一次发送失败（PRD-ui G-UI-22）：每次失败只发一次，界面据此弹一次轻提示，
   * 不用在每次 messages 事件里比较前后状态。error 同 Message.error。
   */
  sendFailed: [convId: string, clientMsgId: string, error: NonNullable<Message['error']>];
  /** 被移出群（convRemoved），界面据此提示"你已不在该群"。 */
  convRemoved: [convId: string];
  /** 被踢或收到不应重连的关闭码，连接已停止，需要回到登录页（C-01）。 */
  fatal: [FatalReason];
};

export type SendResult = { ok: true; message: Message } | Exclude<TextCheck, { ok: true }>;

/**
 * IM 统一 SDK 的入口（PLAN 3.2 的 IMClient）。不依赖任何 UI 框架：界面订阅事件、读取快照即可。
 *
 *   const im = new IMClient({ url: 'wss://host/ws' });
 *   im.on('conversations', render);
 *   im.connect(token);
 */
export class IMClient extends Emitter<ClientEvents> {
  private readonly t: IMClientTimings;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly newId: () => string;
  private readonly isVisible: () => boolean;
  private readonly conn: Connection;
  private store: Store;
  private self = '';
  private autoUsed = new Set<string>(); // 已经自动重发过一次的 clientMsgId
  private gapTimers = new Map<string, TimerHandle>();
  private active: string | null = null;
  private lastRead = -Infinity;
  private lastTotalUnread = 0;
  private lastPendingCount = 0;
  private readTimer: TimerHandle | null = null;
  private bannerTimer: TimerHandle | null = null;
  private bannerShown = false;
  private detach: (() => void) | null = null;

  constructor(o: IMClientOptions) {
    super();
    this.t = { ...DEFAULTS, ...o.timings };
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? silentLogger;
    this.newId = o.newId ?? (() => crypto.randomUUID());
    this.isVisible = o.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    this.onListenerError = (err) => this.log.error('im: listener error', err);
    this.store = new Store(() => this.self);
    this.conn = new Connection({
      url: o.url,
      platform: o.platform ?? 'web',
      transport: o.transport ?? new WebSocketTransport(),
      clock: this.clock,
      logger: this.log,
      random: o.random ?? Math.random,
      ...this.t,
    });
    this.conn.on('state', (s) => this.onState(s));
    this.conn.on('connected', (a) => void this.onConnected(a));
    this.conn.on('frame', (f) => this.onFrame(f));
    this.conn.on('fatal', (r) => this.onFatal(r));
    if (o.browserEvents ?? typeof window !== 'undefined') this.attachBrowserEvents();
  }

  // ---- 公开接口 ----

  /** 当前用户（第一次连接成功后可用）。 */
  get userId(): string {
    return this.self;
  }

  get state(): ConnState {
    return this.conn.state;
  }

  connect(token: string): void {
    this.conn.start(token);
  }

  /** 退出登录：以 1000 关闭，不再重连，清空内存数据（PRD F-AUTH-05）。 */
  disconnect(): void {
    this.conn.stop();
    this.reset();
  }

  /** 释放浏览器事件监听。 */
  destroy(): void {
    this.disconnect();
    this.detach?.();
  }

  conversations(): Conversation[] {
    return this.store.conversations();
  }

  messages(convId: string): Message[] {
    return this.store.messages(convId);
  }

  /**
   * 发送文本。先在本地插入一条"发送中"（离线时"排队"）的消息，ack 后更新为已发送。
   * 文本为空或超过 5000 字时不发送，返回原因。
   */
  send(convId: string, raw: string): SendResult {
    const check = checkText(raw);
    if (!check.ok) return check;
    if (!this.self) throw new NotConnectedError(); // 需要先连接成功一次，才知道自己是谁
    const msg: Message = {
      clientMsgId: this.newId(),
      convId,
      from: this.self,
      type: 'text',
      body: { text: check.text },
      ts: this.clock.now(),
      status: this.conn.state === 'connected' ? 'sending' : 'queued',
    };
    this.store.list(convId).addLocal(msg);
    this.emitMessages(convId);
    if (msg.status === 'sending') this.dispatch(convId, msg.clientMsgId);
    return { ok: true, message: msg };
  }

  /** 手动重发失败的消息，沿用原来的 clientMsgId（PRD F-MSG-03 规则 2）。 */
  retry(convId: string, clientMsgId: string): void {
    const m = this.store.list(convId).local(clientMsgId);
    if (!m || m.status !== 'failed') return;
    if (this.conn.state === 'connected') {
      this.dispatch(convId, clientMsgId);
    } else {
      this.autoUsed.add(clientMsgId); // 手动重发也只自动补发一次
      this.store.list(convId).update(clientMsgId, { status: 'queued', error: undefined });
      this.emitMessages(convId);
    }
  }

  /**
   * 向前翻页加载历史（PRD F-MSG-05）：第一次从最新开始（beforeSeq = maxSeq + 1，20 条），
   * 之后从已加载的最早一条继续往前。返回是否还有更早的。
   */
  async loadHistory(convId: string, limit = LATEST_PAGE): Promise<boolean> {
    const list = this.store.list(convId);
    const conv = this.store.conversation(convId);
    if (!list.hasMoreHistory) return false;
    const before = list.oldestSeq || Math.max(conv?.maxSeq ?? 0, this.store.maxSeq(convId)) + 1;
    if (before <= (conv?.minSeq ?? 1)) {
      list.hasMoreHistory = false;
      return false;
    }
    const ack = await this.conn.request<SyncAck>('sync', { convId, beforeSeq: before, limit });
    for (const m of ack.messages) this.store.applyServerMessage(m);
    list.hasMoreHistory = ack.hasMore;
    this.emitMessages(convId);
    this.emitConversations();
    return ack.hasMore;
  }

  /** 设置当前打开的会话（null 表示不在聊天页），用于已读上报。 */
  setActiveConversation(convId: string | null): void {
    this.active = convId;
    this.maybeReportRead();
  }

  /** 页面可见性变化时调用（开启 browserEvents 时自动调用）。 */
  visibilityChanged(): void {
    this.maybeReportRead();
  }

  /** 网络恢复时调用（开启 browserEvents 时自动调用）：立即重连，不等退避。 */
  networkOnline(): void {
    this.conn.reconnectNow();
  }

  // ---- 连接事件 ----

  private onState(s: ConnState): void {
    this.emit('state', s);
    if (s === 'connected') {
      if (this.bannerTimer !== null) this.clock.clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
      if (this.bannerShown) {
        this.bannerShown = false;
        this.emit('banner', false);
      }
    } else if (!this.bannerShown && this.bannerTimer === null) {
      this.bannerTimer = this.clock.setTimeout(() => {
        this.bannerTimer = null;
        if (this.conn.state !== 'connected') {
          this.bannerShown = true;
          this.emit('banner', true);
        }
      }, this.t.bannerDelayMs);
    }
  }

  /** 连接（含重连）成功：拉会话列表 → 补拉落后的会话 → 发出排队的消息（PRD F-CONN-01 规则 4）。 */
  private async onConnected(a: AuthAck): Promise<void> {
    if (this.self && this.self !== a.userId) this.reset(); // 换了账号
    this.self = a.userId;
    this.flushQueued();
    try {
      const ack = await this.conn.request<ConvsAck>('convs', {});
      this.store.setConversations(ack.convs);
      this.emitConversations();
      for (const c of ack.convs) await this.catchUp(c);
      this.maybeReportRead();
    } catch (err) {
      this.log.warn(`im: initial sync failed: ${String(err)}`);
    }
  }

  /**
   * 补拉一个会话。只补拉本地已经加载过消息的会话；没打开过的会话等打开时再 loadHistory，
   * 否则首次登录要为每个会话拉一遍历史。
   */
  private async catchUp(c: ServerConversation): Promise<void> {
    const local = this.store.maxSeq(c.convId);
    if (local === 0 || c.maxSeq <= local) return;
    const start = Math.max(local, c.minSeq - 1); // 群补拉起点（C-24）
    const list = this.store.list(c.convId);
    if (c.maxSeq - start > MAX_CATCH_UP) {
      // 缺口太大：只加载最新一页，中间的靠向上翻页（AC-CONN-01-8）。
      list.resetServer();
      const ack = await this.conn.request<SyncAck>('sync', {
        convId: c.convId,
        beforeSeq: c.maxSeq + 1,
        limit: LATEST_PAGE,
      });
      for (const m of ack.messages) this.store.applyServerMessage(m);
      list.hasMoreHistory = ack.hasMore;
    } else {
      await this.syncAfter(c.convId, start, c.maxSeq);
    }
    this.emitMessages(c.convId);
    this.emitConversations();
  }

  /** 从 after 开始补拉，直到拿到 until 或者没有更多。 */
  private async syncAfter(convId: string, after: number, until: number): Promise<void> {
    for (;;) {
      const ack = await this.conn.request<SyncAck>('sync', { convId, afterSeq: after, limit: PAGE });
      for (const m of ack.messages) this.store.applyServerMessage(m);
      const last = ack.messages.at(-1)?.seq ?? after;
      if (!ack.hasMore || last >= until || last <= after) return;
      after = last;
    }
  }

  private onFrame(f: InboundFrame): void {
    if (f.cmd === 'msg') {
      this.onMessage(f.data as ServerMessage);
      return;
    }
    if (f.cmd !== 'event') return;
    const ev = f.data as ServerEvent;
    switch (ev.type) {
      case 'convAdded':
        this.store.upsertConversation(ev.conv);
        this.emitConversations();
        return;
      case 'convRemoved':
        this.store.removeConversation(ev.convId);
        this.emitConversations();
        this.emit('convRemoved', ev.convId);
        return;
      case 'readUpdated':
        if (this.store.advanceRead(ev.convId, ev.readSeq)) this.emitConversations();
        return;
    }
  }

  /** 实时消息：合并、检测缺口（F-MSG-04 规则 2）、必要时上报已读。 */
  private onMessage(m: ServerMessage): void {
    const prev = this.store.maxSeq(m.convId);
    if (!this.store.applyServerMessage(m)) return;
    this.emitMessages(m.convId);
    this.emitConversations();
    if (this.store.hasPlaceholder(m.convId)) this.refreshConversationsSoon();
    // 只对已经加载过的会话检测缺口：prev 为 0 说明本地还没有这个会话的消息。
    if (prev > 0 && m.seq > prev + 1) this.scheduleGapCheck(m.convId, prev, m.seq);
    if (m.convId === this.active) this.maybeReportRead();
  }

  /**
   * 本地临时补了会话（第一次和某人聊天、群消息比 convAdded 先到）时，稍后重新拉一次 convs，
   * 用服务端的权威数据（昵称、minSeq、未读）替换临时条目。200ms 内的多次触发合并为一次。
   */
  private refreshConversationsSoon(): void {
    if (this.refreshTimer !== null || this.conn.state !== 'connected') return;
    this.refreshTimer = this.clock.setTimeout(() => {
      this.refreshTimer = null;
      this.conn
        .request<ConvsAck>('convs', {})
        .then((ack) => {
          this.store.setConversations(ack.convs);
          this.emitConversations();
        })
        .catch((err) => this.log.warn(`im: refresh conversations failed: ${String(err)}`));
    }, 200);
  }

  private refreshTimer: TimerHandle | null = null;

  private scheduleGapCheck(convId: string, after: number, until: number): void {
    if (this.gapTimers.has(convId)) return;
    this.gapTimers.set(
      convId,
      this.clock.setTimeout(() => {
        this.gapTimers.delete(convId);
        const list = this.store.list(convId);
        for (let s = after + 1; s < until; s++) {
          if (!list.has(s)) {
            this.syncAfter(convId, after, until)
              .then(() => {
                this.emitMessages(convId);
                this.emitConversations();
              })
              .catch((err) => this.log.warn(`im: gap sync failed: ${String(err)}`));
            return;
          }
        }
      }, this.t.gapWaitMs),
    );
  }

  /** 被踢或不可重连的关闭：发送中 / 排队的消息全部标记失败（AC-AUTH-03-6），通知界面回到登录页。 */
  private onFatal(r: FatalReason): void {
    for (const c of this.store.conversations()) this.failPending(c.convId);
    this.emit('fatal', r);
  }

  private failPending(convId: string): void {
    const list = this.store.list(convId);
    const pending = list.pendingMessages();
    for (const m of pending) list.update(m.clientMsgId, { status: 'failed', error: 'kicked' });
    if (pending.length) this.emitMessages(convId);
    for (const m of pending) this.emit('sendFailed', convId, m.clientMsgId, 'kicked');
  }

  // ---- 发送 ----

  private dispatch(convId: string, clientMsgId: string): void {
    const list = this.store.list(convId);
    const m = list.update(clientMsgId, { status: 'sending', error: undefined });
    if (!m) return;
    this.emitMessages(convId);
    const { convType, to } = parseConvId(convId, this.self);
    const onAck = (ack: SendAck) => {
      this.store.applyServerMessage({
        msgId: ack.msgId,
        clientMsgId,
        convId: ack.convId,
        seq: ack.seq,
        from: this.self,
        type: m.type,
        body: m.body,
        ts: ack.ts,
      });
      this.emitMessages(convId);
      this.emitConversations();
      if (this.store.hasPlaceholder(convId)) this.refreshConversationsSoon();
    };
    this.conn
      .request<SendAck>(
        'send',
        { convType, to, clientMsgId, type: m.type, body: m.body },
        {
          timeoutMs: this.t.sendTimeoutMs,
          // 超时后 ack 才到：以 ack 为准，变为已发送（C-30）。
          onLateAck: (data, err) => {
            if (!err) onAck(data as SendAck);
          },
        },
      )
      .then(onAck)
      .catch((err: unknown) => {
        // 失败回调是异步的：这期间消息可能已经被别的路径改过状态（例如被踢时标记为失败），只处理仍在发送中的。
        if (list.local(clientMsgId)?.status !== 'sending') return;
        if (err instanceof IMError) this.fail(convId, clientMsgId, err.code);
        else if (err instanceof TimeoutError) this.fail(convId, clientMsgId, 'timeout');
        else if (
          (err instanceof ConnectionClosedError || err instanceof NotConnectedError) &&
          !this.autoUsed.has(clientMsgId)
        ) {
          // 发出后连接断了：重连后自动补发一次（PRD F-MSG-03 规则 2）。
          this.autoUsed.add(clientMsgId);
          list.update(clientMsgId, { status: 'queued' });
          this.emitMessages(convId);
        } else this.fail(convId, clientMsgId, 'timeout');
      });
  }

  private fail(convId: string, clientMsgId: string, error: Message['error']): void {
    const m = this.store.list(convId).local(clientMsgId);
    if (!m || m.status !== 'sending') return; // 已经被晚到的 ack 更新为已发送
    this.store.list(convId).update(clientMsgId, { status: 'failed', error });
    this.emitMessages(convId);
    if (error !== undefined) this.emit('sendFailed', convId, clientMsgId, error);
  }

  /** 重连后发出排队的消息，每条只自动发一次。 */
  private flushQueued(): void {
    for (const c of this.allConvIds()) {
      for (const m of this.store.list(c).pendingMessages()) {
        if (m.status !== 'queued') continue;
        this.autoUsed.add(m.clientMsgId);
        this.dispatch(c, m.clientMsgId);
      }
    }
  }

  private allConvIds(): string[] {
    return [...new Set([...this.store.conversations().map((c) => c.convId), ...this.knownLists])];
  }

  private knownLists = new Set<string>();

  // ---- 已读 ----

  /**
   * 页面可见、停在该会话、有未读时上报已读，节流为每秒最多一次（PRD F-CONV-02 规则 3）。
   * 本地立即清零（界面不等 ack），上报值为当前最新 seq。
   */
  private maybeReportRead(): void {
    const convId = this.active;
    if (!convId || !this.isVisible() || this.conn.state !== 'connected') return;
    const c = this.store.conversation(convId);
    const latest = Math.max(c?.maxSeq ?? 0, this.store.maxSeq(convId));
    if (!c || latest <= c.readSeq) return;
    const wait = this.lastRead + this.t.readThrottleMs - this.clock.now();
    if (wait > 0) {
      if (this.readTimer === null) {
        this.readTimer = this.clock.setTimeout(() => {
          this.readTimer = null;
          this.maybeReportRead();
        }, wait);
      }
      return;
    }
    this.lastRead = this.clock.now();
    this.store.advanceRead(convId, latest);
    this.emitConversations();
    this.conn.request('read', { convId, seq: latest }).catch((err) => this.log.warn(`im: read failed: ${String(err)}`));
  }

  // ---- 其他 ----

  /** 全部会话的未读之和。 */
  totalUnread(): number {
    return this.store.conversations().reduce((n, c) => n + c.unread, 0);
  }

  /** 状态为 queued / sending / failed 的消息条数（跨会话）。 */
  pendingCount(): number {
    let n = 0;
    for (const id of this.knownLists) {
      for (const m of this.store.messages(id)) if (m.status !== 'sent') n++;
    }
    return n;
  }

  private emitConversations(): void {
    this.emit('conversations', this.store.conversations());
    const total = this.totalUnread();
    if (total !== this.lastTotalUnread) {
      this.lastTotalUnread = total;
      this.emit('totalUnread', total);
    }
  }

  private emitMessages(convId: string): void {
    this.knownLists.add(convId);
    this.emit('messages', convId, this.store.messages(convId));
    this.emitPendingCount();
  }

  private emitPendingCount(): void {
    const n = this.pendingCount();
    if (n !== this.lastPendingCount) {
      this.lastPendingCount = n;
      this.emit('pendingCount', n);
    }
  }

  private reset(): void {
    for (const t of this.gapTimers.values()) this.clock.clearTimeout(t);
    this.gapTimers.clear();
    if (this.readTimer !== null) this.clock.clearTimeout(this.readTimer);
    this.readTimer = null;
    this.store = new Store(() => this.self);
    this.knownLists.clear();
    this.autoUsed.clear();
    this.active = null;
    this.lastRead = -Infinity;
    this.emitConversations();
    this.emitPendingCount();
  }

  private attachBrowserEvents(): void {
    if (typeof window === 'undefined') return;
    const online = () => this.networkOnline();
    const visibility = () => this.visibilityChanged();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visibility);
    this.detach = () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visibility);
    };
  }
}
