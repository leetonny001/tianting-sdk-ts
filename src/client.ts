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
import { ErrorCode, IMError } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import { MuteTable, type MuteInfo } from './mute.js';
import { PUSH_DEFAULTS, PushSync, type Push, type PushLimits, type PushStart, type PushSyncAck } from './push.js';
import {
  groupConvId,
  parseConvId,
  parseConvIdStrict,
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
import {
  ProfileCache,
  SocialState,
  type ApplySource,
  type BlockedUser,
  tipSummary,
  type GroupInfo,
  type GroupMemberInfo,
  type Friend,
  type FriendRequest,
  type MyGroup,
  type Relation,
  type SearchedUser,
  type SocialChangeAck,
  type SocialItems,
  type SocialSettings,
  type SocialSyncAck,
  type UserProfile,
} from './social.js';
import { Store, type Conversation, type ConversationSnapshot, type Message } from './store.js';
import { checkText, type TextCheck } from './text.js';
import type { SessionEnd, TokenProvider } from './token-provider.js';
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
  /** 没有游标时从哪里开始收推送（PRD-live C10）：默认 beginning；latest 只建立游标不回放，灰度用。 */
  pushStart?: PushStart;
  /** 覆盖推送的上限和等待时间（都未校准，4.3、4.4 节）。 */
  pushLimits?: Partial<PushLimits>;
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
const REFRESH_THROTTLE_MS = 30_000; // refreshConversations 的节流（G-UI-24）
// 禁言最长 30 天，超过 setTimeout 的上限（约 24.8 天，超出会立即触发）：分段等，到点再算一次。
const MUTE_TIMER_MAX_MS = 86_400_000;

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
  /**
   * 被移出群（服务端的 convRemoved，或重连 / 刷新会话列表时推断出来的，G-UI-21），界面据此提示。
   * reason 透传服务端的值（removed / dissolved / left / 不认识的值）；推断出来的没有 reason。
   */
  convRemoved: [convId: string, reason?: string];
  /** 禁言状态变了（muted / unmuted、auth ack、convs、发送返回 4031、到期）：用 muteState(convId) 读当前状态。 */
  muteChanged: [];
  /** 被踢或收到不应重连的关闭码，连接已停止，需要回到登录页（C-01）。 */
  fatal: [FatalReason];
  // ---- 社交（PRD-social 10.1 节）：每次本地社交状态变化时四个一起发出（快照引用在没有变化时保持不变） ----
  /** 好友（不含墓碑）。 */
  friends: [Friend[]];
  /** "新的朋友"（30 天内，按 updatedAt 倒序）与红点数。 */
  friendRequests: [{ items: FriendRequest[]; unseen: number }];
  blocks: [BlockedUser[]];
  socialSettings: [SocialSettings];
  /** 群资料或成员变了（M4）：SDK 已经用 groupInfo 更新了本地会话；打开着群设置的页面直接用 info，不必再查。 */
  groupChanged: [groupId: string, info: GroupInfo];
  /**
   * 系统推送（PRD-live 4.8 节）：只有这个事件的监听器才算订阅者。注册后到下一个微任务才交付积压，
   * 有订阅者才会补拉。带 pushSeq 的至少一次，业务按 pushId 幂等；不带的至多一次。
   */
  push: [Push];
  /** 一轮补拉结束（4.8 节）。可选，不影响交付。 */
  pushSynced: [{ latestSeq: number }];
  /** 账号在新设备登录等安全提醒（PRD-chat F-ACC-02 规则 3b）。不认识的 kind 不发。 */
  securityNotice: [SecurityNotice];
  /** auth ack 说最新一代恢复码没有确认（F-ACC-05 规则 1）：App 强制进保存页。 */
  recoveryCodeUnacked: [];
  /** 某人的资料变了，读 profileOf / displayName（F-ACC-06：自己改昵称后立即显示）。 */
  profileChanged: [userId: string];
};

/** 这一批认识的 securityNotice（server/internal/protocol/frames.go）。 */
const SECURITY_NOTICE_KINDS: ReadonlySet<string> = new Set([
  'newDeviceLogin',
  'recoveryCodeRegenerated',
  'refreshReplay',
  'refreshRateLimited',
]);

export interface SecurityNotice {
  kind: string;
  at: number;
  platform: Platform;
}

/** 社交命令的选项。 */
export interface ApplyFriendOptions {
  message?: string;
  source?: ApplySource;
  /** source=group 时为 groupId。 */
  sourceRef?: string;
  /** 对方同意后我给对方的备注。 */
  remark?: string;
}

const SOCIAL_DEBOUNCE_MS = 200; // socialChanged 去抖（F-SOC-06 规则 6）
const SOCIAL_RETRY_MS = 6_000; // socialFull 限流每 6 秒恢复一轮
const SOCIAL_PAGE = 500;
const USERS_BATCH = 100;

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
  private social = new SocialState();
  private profiles: ProfileCache;
  private serverOffset = 0; // 服务端时间 − 本地时间（auth ack 的 serverTime）
  private socialTimer: TimerHandle | null = null;
  private socialRunning: Promise<void> | null = null;
  private socialSnap: {
    friends: Friend[];
    requests: { items: FriendRequest[]; unseen: number };
    blocks: BlockedUser[];
    settings: SocialSettings;
  };
  private usersQueue = new Map<string, Array<() => void>>();
  private mutes = new MuteTable();
  private muteKey = this.mutes.key() + '[]'; // 没有全群禁言时的角色部分，见 mutesChanged
  private muteTimer: TimerHandle | null = null;
  private readonly pushes: PushSync;
  private provider: TokenProvider | null = null;
  private unsubscribeProvider: Array<() => void> = [];

  constructor(o: IMClientOptions) {
    super();
    this.t = { ...DEFAULTS, ...o.timings };
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? silentLogger;
    this.newId = o.newId ?? (() => crypto.randomUUID());
    this.isVisible = o.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    this.onListenerError = (err) => this.log.error('im: listener error', err);
    this.store = new Store(() => this.self);
    this.profiles = new ProfileCache(() => this.clock.now());
    this.socialSnap = {
      friends: [],
      requests: { items: [], unseen: 0 },
      blocks: [],
      settings: { ...this.social.settings },
    };
    this.conn = new Connection({
      url: o.url,
      platform: o.platform ?? 'web',
      transport: o.transport ?? new WebSocketTransport(),
      clock: this.clock,
      logger: this.log,
      random: o.random ?? Math.random,
      ...this.t,
    });
    this.pushes = new PushSync({
      clock: this.clock,
      log: this.log,
      pushStart: o.pushStart ?? 'beginning',
      limits: { ...PUSH_DEFAULTS, ...o.pushLimits },
      request: (data) => this.conn.request<PushSyncAck>('pushSync', data),
      onSynced: (latestSeq) => this.emit('pushSynced', { latestSeq }),
      onListenerError: (err) => this.onListenerError(err),
    });
    this.conn.on('state', (s) => this.onState(s));
    this.conn.on('connected', (a) => void this.onConnected(a));
    this.conn.on('frame', (f) => this.onFrame(f));
    this.conn.on('fatal', (r) => this.onFatal(r));
    if (o.browserEvents ?? typeof window !== 'undefined') this.attachBrowserEvents();
  }

  // ---- 公开接口 ----

  override on<K extends keyof ClientEvents>(event: K, fn: (...args: ClientEvents[K]) => void): () => void {
    if (event === 'push') return this.pushes.subscribe(fn as unknown as (p: Push) => void);
    return super.on(event, fn);
  }

  /** 推送游标（已交付的最大连续序号）：还没有游标时为 null。 */
  pushCursor(): number | null {
    return this.pushes.cursor;
  }

  /** 当前用户（第一次连接成功后可用）。 */
  get userId(): string {
    return this.self;
  }

  get state(): ConnState {
    return this.conn.state;
  }

  /**
   * 连接。传字符串是演示模式，行为不变；传 AccountClient.tokenProvider 是账号模式：
   * 自动刷新、换 token 重连、4011 比较代号（PRD-chat 第 13.1 节，F-ACC-03 规则 5、7）。
   */
  connect(token: string | TokenProvider): void {
    this.bindProvider(typeof token === 'string' ? null : token);
    this.conn.start(token);
  }

  /** 退出登录：以 1000 关闭，不再重连，清空内存数据（PRD F-AUTH-05）。 */
  disconnect(): void {
    this.bindProvider(null);
    this.conn.stop();
    this.reset();
  }

  private bindProvider(p: TokenProvider | null): void {
    if (p === this.provider) return;
    for (const off of this.unsubscribeProvider) off();
    this.provider = p;
    this.unsubscribeProvider = p
      ? [
          p.onEnded((e) => this.onSessionEnded(e)),
          p.onProfileChanged((userId, nickname) => {
            this.profiles.put({ ...this.profiles.last(userId), userId, nickname } as UserProfile);
            this.emit('profileChanged', userId);
          }),
        ]
      : [];
  }

  /** 账号会话结束：退出时清空数据；其他情况和被踢一样回登录页。来自踢线的，连接已经发过 fatal。 */
  private onSessionEnded(e: SessionEnd): void {
    if (e.origin === 'kick') return;
    this.bindProvider(null);
    this.conn.stop();
    if (e.action === 'logout') {
      this.reset();
      return;
    }
    this.onFatal({ kind: 'session', ...e });
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
    parseConvIdStrict(convId, this.self); // 格式错误在入队前抛错：不留下永远"发送中"的消息
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

  /**
   * 这个会话当前的禁言（PRD-admin F-ADM-40、41、42）：没有被禁言时为 null。
   * 按服务端时间判断到期；用户级优先，群内禁言只影响该群；全群禁言不限制群主、管理员。
   */
  muteState(convId: string): MuteInfo | null {
    return this.mutes.get(convId, this.serverNow(), this.store.conversation(convId)?.myRole);
  }

  /**
   * 调试接口（AC-ADM-31-3）：导出内存里的会话和全部消息副本（含发送队列），是一份拷贝。不包含 token。
   */
  debugExport(): { conversations: unknown[]; messages: Record<string, Message[]> } {
    return JSON.parse(JSON.stringify(this.store.debugExport())) as ReturnType<IMClient['debugExport']>;
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
   * 从本地移除一条失败的消息（PRD-ui G-UI-14）：不发任何帧，不影响服务端。
   * 只对 failed 状态有效，否则不动并返回 false。移除后 pendingCount 减 1，本次登录内不再出现。
   */
  removeFailed(convId: string, clientMsgId: string): boolean {
    if (!this.store.list(convId).removeFailed(clientMsgId)) return false;
    this.emitMessages(convId);
    return true;
  }

  /**
   * 向前翻页加载历史（PRD F-MSG-05）：第一次从最新开始（beforeSeq = maxSeq + 1，20 条），
   * 之后从已加载的最早一条继续往前。返回是否还有更早的。
   */
  async loadHistory(convId: string, limit = LATEST_PAGE): Promise<boolean> {
    const list = this.store.list(convId);
    const conv = this.store.conversation(convId);
    if (!list.hasMoreHistory) return false;
    if (!conv && list.oldestSeq === 0 && this.store.maxSeq(convId) === 0) return this.loadUnknown(convId, limit);
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

  /**
   * 打开本地没有的会话（PRD-ui G-UI-26）：向服务端要最新一页，不按本地 minSeq 提前返回。
   * 4032 / 4033 / 4043 以 IMError 抛给界面（"你已不在该群" / "群聊不存在或已解散"），不吞、不重试；
   * 有消息时把会话补进列表；单聊没有消息时保持本地临时会话。
   */
  private async loadUnknown(convId: string, limit: number): Promise<boolean> {
    const list = this.store.list(convId);
    const ack = await this.conn.request<SyncAck>('sync', { convId, beforeSeq: Number.MAX_SAFE_INTEGER, limit });
    for (const m of ack.messages) this.store.applyServerMessage(m);
    list.hasMoreHistory = ack.hasMore;
    this.emitMessages(convId);
    if (ack.messages.length > 0) {
      this.emitConversations();
      this.refreshConversationsSoon(); // 用服务端数据替换临时补的会话
    }
    return ack.hasMore;
  }

  /** 设置当前打开的会话（null 表示不在聊天页），用于已读上报。 */
  setActiveConversation(convId: string | null): void {
    this.active = convId;
    this.maybeReportRead();
  }

  /** 页面可见性变化时调用（开启 browserEvents 时自动调用）。 */
  visibilityChanged(): void {
    if (this.isVisible()) this.provider?.foreground();
    this.maybeReportRead();
    this.expireMutes(); // 休眠后定时器可能晚到
  }

  /** 网络恢复时调用（开启 browserEvents 时自动调用）：立即重连，不等退避。 */
  networkOnline(): void {
    this.conn.reconnectNow();
    this.expireMutes();
  }

  // ---- 连接事件 ----

  private onState(s: ConnState): void {
    if (s === 'disconnected') this.pushes.onDisconnected();
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
    this.serverOffset = a.serverTime - this.clock.now();
    if (a.recoveryCodeUnacked) {
      this.provider?.recoveryCodeUnacked();
      this.emit('recoveryCodeUnacked');
    }
    this.mutes.setUser(a.mutedUntil); // 没有这个字段表示没有用户级禁言（离线期间可能已经解除）
    this.mutesChanged();
    this.flushQueued();
    this.pushes.onAuth(a.userId, a.serverTime); // 不等 convs、socialSync，互不阻塞（AC-PUSH-03-24）
    try {
      const ack = await this.conn.request<ConvsAck>('convs', {});
      this.applyConvs(ack);
      for (const c of ack.convs) await this.catchUp(c);
      this.maybeReportRead();
    } catch (err) {
      this.log.warn(`im: initial sync failed: ${String(err)}`);
    }
    // 先 convs，再从本地 socialVer 开始一轮关系同步（F-SOC-06 规则 10）。
    this.social.needSync = true;
    void this.syncSocial();
    void this.recheckDeleted();
  }

  /**
   * 重连后重新拉一遍已加载的范围：断开期间被删除的消息不会再发 msgDeleted，只有 sync 才能拿到（F-ADM-31 规则 5），
   * 不拉的话内存里的原文会一直留着。首次连接没有已加载的消息，不发请求。
   */
  private async recheckDeleted(): Promise<void> {
    for (const { convId, from, to } of this.store.loadedRanges()) {
      try {
        if (await this.syncAfter(convId, from - 1, to)) {
          this.emitMessages(convId);
          this.emitConversations();
        }
      } catch (err) {
        this.log.warn(`im: recheck deleted failed: ${String(err)}`);
        return;
      }
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

  /** 从 after 开始补拉，直到拿到 until 或者没有更多。返回本地消息是否有变化。 */
  private async syncAfter(convId: string, after: number, until: number): Promise<boolean> {
    let changed = false;
    for (;;) {
      const ack = await this.conn.request<SyncAck>('sync', { convId, afterSeq: after, limit: PAGE });
      for (const m of ack.messages) if (this.store.applyServerMessage(m)) changed = true;
      const last = ack.messages.at(-1)?.seq ?? after;
      if (!ack.hasMore || last >= until || last <= after) return changed;
      after = last;
    }
  }

  private onFrame(f: InboundFrame): void {
    if (f.cmd === 'msg') {
      this.onMessage(f.data as ServerMessage);
      return;
    }
    if (f.cmd === 'push') {
      this.pushes.onLive(f.data);
      return;
    }
    if (f.cmd !== 'event') return;
    const ev = f.data as ServerEvent;
    switch (ev.type) {
      case 'securityNotice':
        if (SECURITY_NOTICE_KINDS.has(ev.kind)) {
          this.emit('securityNotice', { kind: ev.kind, at: ev.at, platform: ev.platform });
        }
        return;
      case 'convAdded':
        this.store.upsertConversation(ev.conv);
        this.setGroupMute(ev.conv.convId, ev.conv.mutedUntil, ev.conv.allMuted);
        this.mutesChanged();
        this.emitConversations();
        return;
      case 'convRemoved':
        this.store.removeConversation(ev.convId, ev.reason);
        this.setGroupMute(ev.convId, undefined); // 被移出时清除该群的禁言（F-ADM-41 规则 4）
        this.mutesChanged();
        this.emitConversations();
        this.emit('convRemoved', ev.convId, ev.reason);
        return;
      case 'readUpdated':
        if (this.store.advanceRead(ev.convId, ev.readSeq)) this.emitConversations();
        return;
      case 'groupChanged':
        this.onGroupChanged(ev.groupId);
        return;
      case 'msgDeleted':
        this.onMsgDeleted(ev.convId, ev.msgIds ?? [], ev.seqs ?? []);
        return;
      case 'muted':
        this.applyMute(ev.scope, ev.groupId, ev.mutedUntil ?? null);
        return;
      case 'unmuted':
        this.applyMute(ev.scope, ev.groupId, undefined);
        return;
      case 'socialChanged':
        this.social.onSocialChanged(ev.ver);
        if (this.social.needSync) this.syncSocialSoon();
        return;
      case 'socialSettingsChanged':
        this.social.settings = { ...this.social.settings, mode: ev.mode, strangerMsgLimit: ev.strangerMsgLimit };
        this.emitSocial();
        return;
      // 不认识的事件类型忽略（协议 README 第 3 节规则 9）。
    }
  }

  /**
   * 消息被删除（PRD-admin F-ADM-31）：清除内存里的原文，摘要改成占位，未读不变。
   * 还有没拿到 ack 的本地消息时（超时标记失败、ack 丢了），被删的可能正是其中一条：事件里只有 msgId 和 seq，
   * 要向服务端补拉才能按 clientMsgId 对上，并清掉发送队列里的那份原文。
   */
  private onMsgDeleted(convId: string, msgIds: string[], seqs: number[]): void {
    const changed = this.store.deleteMessages(convId, msgIds, seqs);
    if (changed) this.emitMessages(convId);
    this.emitConversations();
    const list = this.store.list(convId);
    const top = Math.max(0, ...seqs);
    const local = this.store.maxSeq(convId);
    if (!list.hasUnsent || top <= local) return;
    this.syncAfter(convId, local || top - 1, top)
      .then(() => {
        this.emitMessages(convId);
        this.emitConversations();
      })
      .catch((err) => this.log.warn(`im: deleted sync failed: ${String(err)}`));
  }

  /** 更新禁言表；不认识的 scope 忽略（协议 README 第 3 节规则 9）。until 为 undefined 表示解除。 */
  private applyMute(scope: unknown, groupId: unknown, until: number | null | undefined): void {
    if (scope === 'user') this.mutes.setUser(until);
    else if (scope === 'group' && typeof groupId === 'string') this.mutes.setGroup(groupId, until);
    else if (scope === 'groupAll' && typeof groupId === 'string') this.mutes.setGroupAll(groupId, until !== undefined);
    else return;
    this.mutesChanged();
  }

  /** 发送返回 4031：按 details 更新状态，界面显示禁用条。这条消息只标记失败，不自动重发。 */
  private onMutedAck(details: Readonly<Record<string, unknown>> | undefined): void {
    if (!details) return;
    if (details.scope === 'groupAll' && typeof details.groupId === 'string') {
      this.onGroupAllDenied(details.groupId);
      return;
    }
    const until = details.mutedUntil;
    if (until === null || typeof until === 'number') this.applyMute(details.scope, details.groupId, until);
  }

  /** 全群禁言下发送被拒：以服务端为准显示禁用条。本地角色还是群主 / 管理员说明角色过期了，补拉一次。 */
  private onGroupAllDenied(groupId: string): void {
    this.mutes.setGroupAll(groupId, true, true);
    this.mutesChanged();
    const role = this.store.conversation(groupConvId(groupId))?.myRole;
    if (role === 'owner' || role === 'admin') this.onGroupChanged(groupId);
  }

  private setGroupMute(convId: string, until: number | null | undefined, allMuted = false): void {
    if (!convId.startsWith('group:')) return;
    const groupId = convId.slice('group:'.length);
    this.mutes.setGroup(groupId, until);
    this.mutes.setGroupAll(groupId, allMuted);
  }

  /** 表有变化时发事件，并按最早的到期时间重新定时。 */
  private mutesChanged(): void {
    if (this.muteTimer !== null) this.clock.clearTimeout(this.muteTimer);
    this.muteTimer = null;
    // 全群禁言是否限制我还取决于我的角色：角色变了也要通知界面。
    const roles = this.mutes.groupAllIds().map((g) => this.store.conversation(groupConvId(g))?.myRole);
    const key = this.mutes.key() + JSON.stringify(roles);
    if (key !== this.muteKey) {
      this.muteKey = key;
      this.emit('muteChanged');
    }
    const next = this.mutes.nextExpiry();
    if (next === null) return;
    const wait = Math.min(Math.max(0, next - this.serverNow()), MUTE_TIMER_MAX_MS);
    this.muteTimer = this.clock.setTimeout(() => {
      this.muteTimer = null;
      this.expireMutes();
    }, wait);
  }

  private expireMutes(): void {
    this.mutes.purge(this.serverNow());
    this.mutesChanged();
  }

  /** 实时消息：合并、检测缺口（F-MSG-04 规则 2）、必要时上报已读。 */
  private onMessage(m: ServerMessage): void {
    const prev = this.store.maxSeq(m.convId);
    if (!this.store.applyServerMessage(m)) return;
    // 提示消息的摘要：本地按服务端同样的规则（只用昵称，F-SOC-29 规则 6）生成，下次 convs 时被权威文本覆盖。
    // 不在这里重拉 convs：大群里一次操作会让所有在线成员同时请求。
    if (m.type === 'tip' && m.body?.tip) {
      const nick = (u: string) => this.profileOf(u)?.nickname || u;
      this.store.setLastMsgText(m.convId, m.msgId, tipSummary(m.body.tip, nick));
    }
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
        .then((ack) => this.applyConvs(ack))
        .catch((err) => this.log.warn(`im: refresh conversations failed: ${String(err)}`));
    }, 200);
  }

  private refreshTimer: TimerHandle | null = null;

  /** 用 convs 的结果覆盖会话列表；原来在、新列表没有的群视为被移出（截断时不推断）。 */
  private applyConvs(ack: ConvsAck): void {
    const gone = this.store.setConversations(ack.convs, ack.truncated);
    this.lastRefreshAt = this.clock.now();
    for (const c of ack.convs) {
      this.setGroupMute(c.convId, c.mutedUntil, c.allMuted);
      // 错过了 msgDeleted 的话，摘要是唯一的线索：本地已加载的那条也要清掉。
      if (c.lastMsg?.deleted && this.store.deleteMessages(c.convId, [c.lastMsg.msgId], [])) this.emitMessages(c.convId);
    }
    for (const id of gone) this.setGroupMute(id, undefined);
    this.mutesChanged();
    this.emitConversations();
    for (const id of gone) this.emit('convRemoved', id);
  }

  private lastRefreshAt = -Infinity;

  /**
   * 重新拉取会话列表（PRD-ui G-UI-24：进入群聊天页 / 聊天信息页时刷新成员数）。30 秒内只拉一次，
   * 节流期内直接返回当前快照。
   */
  async refreshConversations(): Promise<Conversation[]> {
    if (this.clock.now() - this.lastRefreshAt < REFRESH_THROTTLE_MS || this.conn.state !== 'connected') {
      return this.store.conversations();
    }
    this.lastRefreshAt = this.clock.now();
    this.applyConvs(await this.conn.request<ConvsAck>('convs', {}));
    return this.store.conversations();
  }

  /** 最近一次会话列表是否被截断（只返回最近 500 个，C-03）。 */
  truncated(): boolean {
    return this.store.truncated;
  }

  /** 被移出群后保留的快照（本次登录期间有效）；没有被移出时返回 undefined。 */
  conversationSnapshot(convId: string): ConversationSnapshot | undefined {
    return this.store.snapshot(convId);
  }

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
    this.bindProvider(null);
    this.clearSocial(); // 被踢：清空全部社交状态（PRD-social 10.2 节）
    // 按消息列表遍历：第一次发给新联系人时，会话还不在会话列表里（AC-AUTH-03-6）。
    for (const convId of this.store.messageConvIds()) this.failPending(convId);
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
    const type = m.type;
    const onAck = (ack: SendAck) => {
      // 正文在 ack 到的时候再取：等待期间消息可能已经被删除，回调不能留着一份原文。
      this.store.applyServerMessage({
        msgId: ack.msgId,
        clientMsgId,
        convId: ack.convId,
        seq: ack.seq,
        from: this.self,
        type,
        body: list.local(clientMsgId)?.body,
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
            else if (err.code === ErrorCode.MUTED) this.onMutedAck(err.details);
          },
        },
      )
      .then(onAck)
      .catch((err: unknown) => {
        // 失败回调是异步的：这期间消息可能已经被别的路径改过状态（例如被踢时标记为失败），只处理仍在发送中的。
        if (err instanceof IMError && err.code === ErrorCode.MUTED) this.onMutedAck(err.details);
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
    this.pushes.logout();
    this.mutes.clear();
    this.mutesChanged();
    this.clearSocial();
    this.knownLists.clear();
    this.autoUsed.clear();
    this.active = null;
    this.lastRead = -Infinity;
    this.emitConversations();
    this.emitPendingCount();
  }

  // ---- 社交（PRD-social FE-101～FE-103） ----

  /** 按服务端时间的"现在"：申请过期、30 天都用它判断，不用本地时钟（PRD-core 3.1 节）。 */
  serverNow(): number {
    return this.clock.now() + this.serverOffset;
  }

  friends(): Friend[] {
    return this.socialSnap.friends;
  }

  friendRequests(): { items: FriendRequest[]; unseen: number } {
    return this.socialSnap.requests;
  }

  blocks(): BlockedUser[] {
    return this.socialSnap.blocks;
  }

  socialSettings(): SocialSettings {
    return this.socialSnap.settings;
  }

  /** 是否完成过至少一轮关系同步（通讯录首轮未结束时显示骨架屏）。 */
  socialLoaded(): boolean {
    return this.social.loaded;
  }

  /** 我自己是否为官方账号。 */
  isOfficial(): boolean {
    return this.social.official;
  }

  /** 立即从本地 socialVer 同步一轮（例如 friendRespond 返回 4045 之后刷新状态，同时按服务端时间重算过期）。 */
  refreshSocial(): Promise<void> {
    this.social.needSync = true;
    return this.syncSocial();
  }

  /** 只看本地的关系（与 userSearch 的 relation 同一枚举）。 */
  relationOf(userId: string): Relation {
    return this.social.relationOf(userId, this.self, this.serverNow());
  }

  /** 最近一次拿到的资料（缓存，可能已过期；没有为 undefined）。 */
  profileOf(userId: string): UserProfile | undefined {
    return this.profiles.last(userId);
  }

  /** 显示名：好友备注 → 昵称 → userId（备注只在本机显示，PRD-social 5.5 节）。 */
  displayName(userId: string): string {
    const f = this.social.friends.get(userId);
    if (f && !f.deleted && f.remark) return f.remark;
    return this.profiles.last(userId)?.nickname || userId;
  }

  async applyFriend(userId: string, opts: ApplyFriendOptions = {}): Promise<'pending' | 'accepted'> {
    const ack = await this.socialCmd('friendApply', { to: userId, ...opts });
    return ack.status ?? 'pending';
  }

  async respondFriend(userId: string, action: 'accept' | 'reject', opts: { remark?: string } = {}): Promise<void> {
    await this.socialCmd('friendRespond', { from: userId, action, ...opts });
  }

  async deleteFriend(userId: string): Promise<void> {
    await this.socialCmd('friendDelete', { userId });
  }

  async setFriendRemark(userId: string, remark: string): Promise<void> {
    await this.socialCmd('friendRemark', { userId, remark });
  }

  async block(userId: string): Promise<void> {
    await this.socialCmd('block', { userId });
  }

  async unblock(userId: string): Promise<void> {
    await this.socialCmd('unblock', { userId });
  }

  /** 进入"新的朋友"时调用：本地红点立即清零，上报当前 socialVer（F-SOC-04 规则 3）。 */
  markFriendRequestsSeen(): void {
    const ver = this.social.ver;
    if (ver <= this.social.requestSeenVer) return;
    this.social.requestSeenVer = ver;
    this.emitSocial();
    this.conn
      .request<{ requestSeenVer: number; ver: number; changed: boolean }>('friendRequestsSeen', { ver })
      .then((ack) => {
        this.social.applyAck(ack.ver, ack.changed);
        this.afterSocialAck();
      })
      .catch((err) => this.log.warn(`im: friendRequestsSeen failed: ${String(err)}`));
  }

  async setSearchable(searchable: boolean): Promise<void> {
    const ack = await this.conn.request<{ ver: number; changed: boolean }>('setPrivacy', { searchable });
    this.social.settings = { ...this.social.settings, searchable };
    this.social.applyAck(ack.ver, ack.changed);
    this.afterSocialAck();
  }

  /** 精确搜索 userId（不存在、不可被搜索都是 null）。结果里的资料写进缓存，供申请页 / 资料卡使用。 */
  async searchUser(keyword: string): Promise<SearchedUser | null> {
    const ack = await this.conn.request<{ user: SearchedUser | null }>('userSearch', { keyword });
    if (ack.user) this.profiles.put(ack.user);
    return ack.user;
  }

  /**
   * 批量查资料（F-SOC-10）：命中缓存的不请求；同一事件循环内的调用合并，每批最多 100 个。
   * 返回可见的用户；不在可见范围内、不存在的不返回（两者无法区分）。
   */
  async getUsers(userIds: string[]): Promise<UserProfile[]> {
    const ids = [...new Set(userIds)];
    const missing = ids.filter((id) => this.profiles.needsFetch(id));
    if (missing.length) {
      const first = this.usersQueue.size === 0;
      // 每个 id 一个 Promise：跨批时要等这次要的人都回来，只等第一批会漏人。
      const done = missing.map(
        (id) =>
          new Promise<void>((resolve) => {
            const waiters = this.usersQueue.get(id) ?? [];
            waiters.push(resolve);
            this.usersQueue.set(id, waiters);
          }),
      );
      if (first) queueMicrotask(() => void this.flushUsers());
      await Promise.all(done);
    }
    return ids.map((id) => this.profiles.fresh(id)).filter((p): p is UserProfile => !!p);
  }

  private async flushUsers(): Promise<void> {
    const queue = this.usersQueue;
    this.usersQueue = new Map();
    const ids = [...queue.keys()];
    for (let i = 0; i < ids.length; i += USERS_BATCH) {
      const batch = ids.slice(i, i + USERS_BATCH);
      try {
        const ack = await this.conn.request<{ users: UserProfile[] }>('users', { userIds: batch });
        for (const u of ack.users) this.profiles.put(u);
        for (const id of batch) if (!this.profiles.fresh(id)) this.profiles.markMissing(id);
      } catch (err) {
        this.log.warn(`im: users failed: ${String(err)}`);
      }
      for (const id of batch) for (const resolve of queue.get(id) ?? []) resolve();
    }
  }

  /** 我的群聊（F-SOC-11）：自动翻完全部页，按 groupId 升序。 */
  async loadMyGroups(): Promise<MyGroup[]> {
    const out: MyGroup[] = [];
    let cursor = '';
    for (;;) {
      const ack = await this.conn.request<{ groups: MyGroup[]; nextCursor: string }>(
        'myGroups',
        cursor ? { cursor } : {},
      );
      out.push(...ack.groups);
      if (!ack.nextCursor) return out;
      cursor = ack.nextCursor;
    }
  }

  // ---- 群（PRD-social FE-110、FE-111） ----

  /** 建群：自动生成 clientReqId，超时重试用同一个（不会重复建群，F-SOC-21 规则 1）。 */
  async createGroup(opts: { name?: string; members: string[] }): Promise<{ groupId: string; conv: Conversation }> {
    const clientReqId = this.newId();
    const data = { clientReqId, members: opts.members, ...(opts.name ? { name: opts.name } : {}) };
    for (let attempt = 0; ; attempt++) {
      try {
        const ack = await this.conn.request<{ groupId: string; conv: ServerConversation }>('groupCreate', data);
        this.store.upsertConversation(ack.conv);
        this.setGroupMute(ack.conv.convId, ack.conv.mutedUntil, ack.conv.allMuted);
        this.mutesChanged();
        this.emitConversations();
        const conv = this.store.conversation(ack.conv.convId)!;
        return { groupId: ack.groupId, conv };
      } catch (err) {
        if (!(err instanceof TimeoutError) || attempt >= 2) throw err;
      }
    }
  }

  async inviteToGroup(
    groupId: string,
    members: string[],
  ): Promise<{ added: string[]; failed: Array<{ userId: string; code: number }> }> {
    return this.conn.request('groupInvite', { groupId, members });
  }

  /** 退群：本连接不会收到 convRemoved，本地直接按 left 处理。 */
  async leaveGroup(groupId: string): Promise<void> {
    await this.conn.request('groupLeave', { groupId });
    this.removeLocally(groupId, 'left');
  }

  async kickFromGroup(groupId: string, members: string[]): Promise<string[]> {
    return (await this.conn.request<{ removed: string[] }>('groupKick', { groupId, members })).removed;
  }

  async transferGroupOwner(groupId: string, to: string): Promise<void> {
    await this.conn.request('groupTransfer', { groupId, to });
    this.onGroupChanged(groupId);
  }

  async setGroupAdmin(groupId: string, userId: string, admin: boolean): Promise<void> {
    await this.conn.request('groupSetAdmin', { groupId, userId, admin });
  }

  async dissolveGroup(groupId: string): Promise<void> {
    await this.conn.request('groupDissolve', { groupId });
    this.removeLocally(groupId, 'dissolved');
  }

  async updateGroup(groupId: string, patch: { name?: string; notice?: string }): Promise<void> {
    await this.conn.request('groupUpdate', { groupId, ...patch });
  }

  /** 群资料；同时更新本地会话的 myRole、memberCount、name。 */
  async getGroupInfo(groupId: string): Promise<GroupInfo> {
    const info = await this.conn.request<GroupInfo>('groupInfo', { groupId });
    if (this.store.updateGroupMeta(groupConvId(groupId), info)) this.emitConversations();
    this.mutes.clearGroupAllDenied(groupId);
    this.mutesChanged();
    return info;
  }

  /** 一页群成员（群主 → 管理员 → 成员）；资料写进缓存。 */
  async loadGroupMembers(
    groupId: string,
    cursor?: string,
  ): Promise<{ members: GroupMemberInfo[]; nextCursor: string }> {
    const ack = await this.conn.request<{ members: GroupMemberInfo[]; nextCursor: string }>('groupMembers', {
      groupId,
      ...(cursor ? { cursor } : {}),
    });
    for (const m of ack.members) this.profiles.put(m);
    return ack;
  }

  private removeLocally(groupId: string, reason: string): void {
    const convId = groupConvId(groupId);
    this.store.removeConversation(convId, reason);
    this.setGroupMute(convId, undefined);
    this.mutesChanged();
    this.emitConversations();
    this.emit('convRemoved', convId, reason);
  }

  /** groupChanged：刷新这个群的资料，不重拉 convs；同一个群的在途请求合并（F-SOC-20 规则 5）。 */
  private onGroupChanged(groupId: string): void {
    if (this.groupInfoInFlight.has(groupId)) {
      this.groupInfoInFlight.set(groupId, true);
      return;
    }
    this.groupInfoInFlight.set(groupId, false);
    let info: GroupInfo | undefined;
    this.getGroupInfo(groupId)
      .then((v) => (info = v))
      .catch((err) => this.log.warn(`im: groupInfo failed: ${String(err)}`))
      .finally(() => {
        const again = this.groupInfoInFlight.get(groupId);
        this.groupInfoInFlight.delete(groupId);
        if (again) this.onGroupChanged(groupId);
        else if (info) this.emit('groupChanged', groupId, info);
      });
  }

  private groupInfoInFlight = new Map<string, boolean>();

  private async socialCmd(cmd: string, data: Record<string, unknown>): Promise<SocialChangeAck> {
    const ack = await this.conn.request<SocialChangeAck>(cmd, data);
    this.cacheProfiles(ack.items);
    this.social.applyAck(ack.ver, ack.changed, ack.items);
    this.afterSocialAck();
    return ack;
  }

  private afterSocialAck(): void {
    this.emitSocial();
    if (this.social.needSync) void this.syncSocial();
  }

  private cacheProfiles(items: SocialItems): void {
    for (const f of items.friends) this.profiles.putProfile(f.userId, f.profile);
    for (const r of items.requests) this.profiles.putProfile(r.userId, r.profile);
    for (const b of items.blocks) this.profiles.putProfile(b.userId, b.profile);
  }

  private syncSocialSoon(): void {
    if (this.socialTimer !== null) return;
    this.socialTimer = this.clock.setTimeout(() => {
      this.socialTimer = null;
      void this.syncSocial();
    }, SOCIAL_DEBOUNCE_MS);
  }

  /** 跑同步轮直到不再需要（F-SOC-06 规则 3、8）。同一时刻只有一个在跑；期间收到的事件在本轮结束后处理。 */
  private syncSocial(): Promise<void> {
    if (this.socialRunning) return this.socialRunning;
    const run = async () => {
      for (let rounds = 0; this.social.needSync && this.conn.state === 'connected' && rounds < 20; rounds++) {
        const since = this.social.beginRound();
        let data: Record<string, unknown> = { sinceVer: since, limit: SOCIAL_PAGE };
        try {
          for (;;) {
            const page = await this.conn.request<SocialSyncAck>('socialSync', data);
            this.cacheProfiles(page);
            const next = this.social.applyPage(page);
            if (next === 'done') break;
            data =
              next === 'continue'
                ? { cursor: page.cursor, limit: SOCIAL_PAGE }
                : { sinceVer: since, limit: SOCIAL_PAGE };
          }
        } catch (err) {
          this.social.abortRound();
          this.log.warn(`im: socialSync failed: ${String(err)}`);
          // 全量轮被限流（每分钟 10 轮，例如频繁刷新页面）：稍后重试，否则首轮同步一直结束不了。
          // 其他失败等下一次事件或重连。
          if (err instanceof IMError && err.code === ErrorCode.RATE_LIMITED) {
            this.social.needSync = true;
            if (this.socialTimer === null) {
              this.socialTimer = this.clock.setTimeout(() => {
                this.socialTimer = null;
                void this.syncSocial();
              }, SOCIAL_RETRY_MS);
            }
          }
          break;
        }
        this.emitSocial();
      }
    };
    this.socialRunning = run().finally(() => {
      this.socialRunning = null;
    });
    return this.socialRunning;
  }

  /** 重新计算社交快照并发出四个事件。 */
  private emitSocial(): void {
    const now = this.serverNow();
    const s = this.social;
    const friends: Friend[] = [];
    for (const f of s.friends.values()) {
      if (f.deleted) continue;
      const name = f.remark || f.profile?.nickname || this.profiles.last(f.userId)?.nickname || f.userId;
      friends.push({ ...f, displayName: name, blocked: s.isBlocked(f.userId) });
    }
    const items: FriendRequest[] = s.requestList(now).map((r) => {
      const p = r.profile ?? this.profiles.last(r.userId) ?? null; // 发出的申请对方同意前没有资料：用手里已有的
      return { ...r, displayName: p?.nickname || r.userId };
    });
    const blocks: BlockedUser[] = [];
    for (const b of s.blocks.values()) {
      if (!b.deleted) blocks.push({ ...b, displayName: b.profile?.nickname || b.userId });
    }
    blocks.sort((a, b) => b.createdAt - a.createdAt);
    this.socialSnap = {
      friends,
      requests: { items, unseen: s.unseen(now) },
      blocks,
      settings: { ...s.settings },
    };
    this.emit('friends', friends);
    this.emit('friendRequests', this.socialSnap.requests);
    this.emit('blocks', blocks);
    this.emit('socialSettings', this.socialSnap.settings);
  }

  private clearSocial(): void {
    if (this.socialTimer !== null) this.clock.clearTimeout(this.socialTimer);
    this.socialTimer = null;
    this.social.clear();
    this.profiles.clear();
    this.emitSocial();
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
