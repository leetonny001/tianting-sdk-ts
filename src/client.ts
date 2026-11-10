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
import { AccountError } from './account.js';
import { ErrorCode, IMError } from './errors.js';
import {
  sizeOf,
  UploadPutError,
  type FileClient,
  type FileInput,
  type FileUrlItem,
  type FileUrlResult,
  type ProcessedImage,
  type UploadData,
} from './files.js';
import { silentLogger, type Logger } from './logger.js';
import { MuteTable, type MuteInfo } from './mute.js';
import { PUSH_DEFAULTS, PushSync, type Push, type PushLimits, type PushStart, type PushSyncAck } from './push.js';
import {
  groupConvId,
  parseConvId,
  parseConvIdStrict,
  type AuthAck,
  type ConvDeleteAck,
  type ConvSetAck,
  type ConvsAck,
  type GroupRole,
  type InboundFrame,
  type LastMsg,
  type Mentions,
  type Platform,
  type QuoteView,
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
import { quoteSummary, recallNoticeOf, recallText, type RecallNotice } from './recall.js';
import {
  sameSettings,
  Store,
  type ConvSettings,
  type Conversation,
  type ConversationSnapshot,
  type Message,
  type MessageError,
  type RecallInfo,
} from './store.js';
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
  /** 图片和文件（PRD-chat 第 13.1 节）。没有时 sendImage、sendFile、getFileUrls 抛错。 */
  files?: FileClient;
}

/**
 * 下载中途所在的消息被撤回（recalled）或删除、过期：已中止（AC-RCL-03-12，和 sdk-kotlin 同名）。
 * H5 的下载交给浏览器之后停不了（frontend-chat 问题 16），SDK 这一段是取下载地址：地址还没交出去就中止。
 */
export class DownloadAbortedError extends Error {
  constructor(
    readonly fileId: string,
    readonly recalled: boolean,
  ) {
    super(recalled ? 'download aborted: message recalled' : 'download aborted: file unavailable');
    this.name = 'DownloadAbortedError';
  }
}

/** 进行中的 downloadUrl：所在消息被撤回、删除或文件过期时由 emitMessages 中止。 */
interface PendingDownload {
  abort: (recalled: boolean) => void;
}

/** sendImage、sendFile 的选项。 */
export interface AttachmentOptions {
  /** 上传进度：已发送字节、总字节（原图 + 缩略图）。 */
  onProgress?: (sent: number, total: number) => void;
  /** 中止等于 cancelUpload。 */
  signal?: AbortSignal;
}

/** 附件的源（F-FILE-07 规则 2：H5 只在内存，刷新就没有了）。上传成功、消息发出后释放。 */
interface AttachmentSource {
  kind: 'image' | 'file';
  /** 还没处理好的图片：轮到它时才调用（并发 1，规则 6）。 */
  produce?: () => Promise<ProcessedImage>;
  image?: ProcessedImage;
  file?: FileInput;
  onProgress?: (sent: number, total: number) => void;
}

interface UploadJob {
  convId: string;
  clientMsgId: string;
  abort: AbortController;
  /** 申请成功后才有：取消时据此发 DELETE。 */
  fileId?: string;
  completed: boolean;
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
/** 提及计数的刷新节流（F-MEN-03 规则 1，未校准）：5 秒内最多拉一次 convs，窗口内的事件在窗口结束时补拉一次。 */
const MENTION_REFRESH_MS = 5_000;
/** 撤回时限（PRD-chat F-RCL-01 规则 1、F-RCL-02 规则 2 的默认值）。服务端可以配置，不一致时以服务端的 4097 为准。 */
export const RECALL_WINDOW_MS = 120_000;
export const GROUP_RECALL_WINDOW_MS = 7 * 86_400_000;
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
  /** 总未读有变化（与 conversations 同一轮发出，PRD-ui G-UI-15）：口径同 totalUnread()。 */
  totalUnread: [number];
  /**
   * 会话被删除（本端 deleteConv 成功，或同一账号的其他设备删除了它，F-CVS-04 规则 1）：本地消息已清除，
   * 页面清除这个会话的草稿（F-CVS-03 规则 7，草稿按会话清，不只是操作的那台，frontend-chat 第 55 条）。
   */
  convDeleted: [convId: string];
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
  /**
   * 这些文件已过期或所在消息被删除（F-FILE-06 规则 3、AC-FILE-06-12）：SDK 已经丢掉它们的地址，
   * App 清掉按 fileId + variant 缓存的图片。
   */
  filesExpired: [fileIds: string[]];
  /**
   * 正在 downloadUrl 的文件所在的消息被撤回（recalled = true，AC-RCL-03-12：提示"该消息已被撤回"）或被删除、过期（false）：
   * 下载已中止，downloadUrl 抛 DownloadAbortedError（和 sdk-kotlin 的 DownloadAborted 同名同义，问题 33）。先于 filesExpired。
   */
  downloadAborted: [fileId: string, recalled: boolean];
  /** 某人的资料变了，读 profileOf / displayName（F-ACC-06：自己改昵称后立即显示）。 */
  profileChanged: [userId: string];
};

/** 这一批认识的 securityNotice：服务端实际发的全部（server/internal/account 的 notify 调用）。 */
const SECURITY_NOTICE_KINDS: ReadonlySet<string> = new Set([
  'newDeviceLogin',
  'passwordChanged',
  'passwordRecovered',
  'recoveryCodeRegenerated',
  'refreshReplay',
  'refreshRateLimited',
  'newIpPrefix',
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

/** send 的第三个参数（PRD-chat 第 13.1 节，R-CF-26）。 */
export interface SendOptions {
  /** 引用一条已发送的消息（F-QUO-01）：上行只发 msgId；本地待发的消息用已加载的原消息先拼出引用条。 */
  quote?: { msgId: string };
  /**
   * @（F-MEN-01、02）：只在群聊。userIds 去重；全空且没有 all 时不带。人数上限由服务端判断（4131）。
   * 正文里的 "@昵称 " 由 App 插入（用资料昵称，不用备注，R-CF-03），服务端不解析正文。
   */
  mentions?: Mentions;
}

/** 消息菜单里 SDK 判断的几项（F-UI-09 扩展，PRD-chat 第 13.3 节）。举报随 C6；失败消息的重发、删除由页面按 status 判断。 */
export type MessageAction = 'copy' | 'quote' | 'recall';

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
  private readonly files: FileClient | null;
  private sources = new Map<string, AttachmentSource>(); // clientMsgId → 源
  /** 这台设备自己上传、complete 成功的 fileId（F-FILE-07 规则 4，v1.4）：send 回 4048 时只有这些按已清理处理。退出登录清空。 */
  private ownFileIds = new Set<string>();
  private uploadQueue: Array<{ convId: string; clientMsgId: string }> = [];
  private job: UploadJob | null = null;
  /** 最近一次重拉时各会话的 modVer（F-RCL-03 规则 2）：变了才重拉这个会话的已加载范围。 */
  private modVers = new Map<string, number>();

  constructor(o: IMClientOptions) {
    super();
    this.t = { ...DEFAULTS, ...o.timings };
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? silentLogger;
    this.newId = o.newId ?? (() => crypto.randomUUID());
    this.isVisible = o.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    this.onListenerError = (err) => this.log.error('im: listener error', err);
    this.store = new Store(() => this.self);
    this.files = o.files ?? null;
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
   * 文本为空或超过 5000 字时不发送，返回原因。opts 可以带引用和 @（C4）：单聊带 mentions 直接抛错（服务端也会 4000）。
   * 4040（reason=quoteUnavailable）、4293（@ 所有人次数用完）、4131 和其他错误码一样标记失败，不自动重发。
   */
  send(convId: string, raw: string, opts: SendOptions = {}): SendResult {
    const check = checkText(raw);
    if (!check.ok) return check;
    if (!this.self) throw new NotConnectedError(); // 需要先连接成功一次，才知道自己是谁
    const { convType } = parseConvIdStrict(convId, this.self); // 格式错误在入队前抛错：不留下永远"发送中"的消息
    const body: Message['body'] = { text: check.text };
    if (opts.quote) body.quote = this.localQuote(convId, opts.quote.msgId);
    const mentions = normalizeMentions(opts.mentions);
    if (mentions) {
      if (convType !== 'group') throw new TypeError('mentions are only allowed in group conversations');
      body.mentions = mentions;
    }
    const msg: Message = {
      clientMsgId: this.newId(),
      convId,
      from: this.self,
      type: 'text',
      body,
      ts: this.clock.now(),
      status: this.conn.state === 'connected' ? 'sending' : 'queued',
    };
    this.store.list(convId).addLocal(msg);
    this.emitMessages(convId);
    if (msg.status === 'sending') this.dispatch(convId, msg.clientMsgId);
    return { ok: true, message: msg };
  }

  /** 本地待发消息里的引用条：被引用的消息已加载时按服务端同样的规则拼摘要（F-QUO-02 规则 2），否则只有 msgId。 */
  private localQuote(convId: string, msgId: string): QuoteView {
    const list = this.store.list(convId);
    const m = list.findByMsgId(msgId);
    if (!m) return { msgId, state: 'normal' };
    const q: QuoteView = { msgId, seq: m.seq, from: m.from, type: m.type, state: 'normal' };
    if (m.deleted) q.state = m.recalled ? 'recalled' : 'deleted';
    else q.text = quoteSummary(m);
    return q;
  }

  /**
   * 撤回（PRD-chat F-RCL-01、02，第 13.1 节）。成功后本地立即按撤回处理：清除原文、引用它的原文、文件缓存
   * （服务端不给发起撤回的这条连接发 msgDeleted，只回 ack）。失败抛 IMError，不自动重试：
   * 4097 带 details.windowSeconds（messageFor('recall', 4097, {windowSeconds}) 给文案）；
   * 4030 是没有权限（"你没有权限撤回这条消息"，管理员撤回其他管理员，AC-RCL-02-5）；4044 消息不存在或已被后台删除。
   * 重复撤回是幂等成功。
   */
  async recall(convId: string, msgId: string): Promise<void> {
    if (!this.self) throw new NotConnectedError();
    await this.conn.request('recall', { convId, msgId });
    const seq = this.store.list(convId).findByMsgId(msgId)?.seq;
    this.applyDeleted(convId, [msgId], seq !== undefined ? [seq] : [], { by: this.self, at: this.serverNow() });
  }

  /**
   * 置顶 / 取消置顶（PRD-chat F-CVS-01，第 13.1 节）。乐观更新：本地先改（置顶时间先用校正后的服务端时间），
   * ack 的 conv 覆盖本地；失败（5000、4220 置顶已满、4290、4030 开关关闭或没有权限、超时、未连接）回滚并抛出，
   * 不自动重试（frontend-chat 第 56 条）。
   */
  async setConvPinned(convId: string, pinned: boolean): Promise<void> {
    await this.changeSettings(convId, { pinned }, (s) =>
      pinned
        ? { ...s, pinned: true, pinnedAt: s.pinned ? s.pinnedAt : this.serverNow() }
        : { notifyOff: s.notifyOff, pinned: false },
    );
  }

  /** 免打扰 / 取消免打扰（F-CVS-02）。乐观更新和失败处理同 setConvPinned。 */
  async setConvNotifyOff(convId: string, on: boolean): Promise<void> {
    await this.changeSettings(convId, { notifyOff: on }, (s) => ({ ...s, notifyOff: on }));
  }

  private async changeSettings(
    convId: string,
    data: { pinned?: boolean; notifyOff?: boolean },
    next: (s: ConvSettings) => ConvSettings,
  ): Promise<void> {
    if (!this.self) throw new NotConnectedError();
    const before = this.store.settings(convId);
    const optimistic = before && next(before);
    if (optimistic && this.store.setSettings(convId, optimistic)) this.emitConversations();
    let ack: ConvSetAck;
    try {
      ack = await this.conn.request<ConvSetAck>('convSet', { convId, ...data });
    } catch (err) {
      // 回滚只在本地还是这次乐观的值时做：等待期间其他端的 convSettingsChanged 已经改过的不覆盖。
      const now = this.store.settings(convId);
      if (before && optimistic && now && sameSettings(now, optimistic) && this.store.setSettings(convId, before)) {
        this.emitConversations();
      }
      throw err;
    }
    this.store.applyConvAck(ack.conv);
    this.setGroupMute(ack.conv.convId, ack.conv.mutedUntil, ack.conv.allMuted);
    this.mutesChanged();
    this.emitConversations();
  }

  /**
   * 删除会话（F-CVS-03）：upToSeq 是本地看到的最大 seq。乐观更新：会话先从列表消失；成功后按 clearedSeq 物理清除本地消息
   * 和文件缓存（filesExpired），这个会话还没发出的附件取消上传（DELETE 临时对象）、排队和失败的消息丢弃（frontend-chat 第 59 条），
   * 然后发 convDeleted 让页面清草稿。失败时会话恢复、抛出，不自动重试（第 56 条）。确认框由页面弹。
   */
  async deleteConv(convId: string): Promise<void> {
    if (!this.self) throw new NotConnectedError();
    const upToSeq = Math.max(this.store.maxSeq(convId), this.store.conversation(convId)?.maxSeq ?? 0);
    this.store.hideForDelete(convId);
    this.emitConversations();
    let ack: ConvDeleteAck;
    try {
      ack = await this.conn.request<ConvDeleteAck>('convDelete', { convId, upToSeq });
    } catch (err) {
      if (this.store.cancelDelete(convId)) this.emitConversations();
      throw err;
    }
    this.discardUnsent(convId);
    this.onConvCleared(convId, ack.clearedSeq);
  }

  /** 丢掉这个会话还没发出的消息：附件按 cancelUpload（已申请的发 DELETE），文本的排队、失败消息直接移除。发送中的不动。 */
  private discardUnsent(convId: string): void {
    const list = this.store.list(convId);
    for (const m of this.store.messages(convId)) {
      if (m.seq !== undefined) continue;
      if (m.type === 'image' || m.type === 'file') this.cancelUpload(convId, m.clientMsgId);
      else if (list.removeUnsent(m.clientMsgId, ['queued', 'failed'])) this.sources.delete(m.clientMsgId);
    }
  }

  /** 本端删除成功或收到其他端的 convDeleted：清除、移除，通知页面清草稿（AC-CVS-04-5）。 */
  private onConvCleared(convId: string, clearedSeq: number): void {
    this.store.clearConversation(convId, clearedSeq);
    this.emitMessages(convId);
    this.emitConversations();
    this.emit('convDeleted', convId);
  }

  /**
   * 这条消息现在能不能撤回（菜单里显示"撤回"，AC-RCL-01-8）：按消息 ts 和 auth ack 校正后的服务端时间判断，不用设备时钟。
   * 自己的消息 2 分钟内；群主、管理员撤回自己的取更宽的 7 天；群主 7 天内任何人的；管理员 7 天内别人的
   * （对方是管理员或群主时服务端回 4030，客户端不知道对方角色，F-RCL-02 规则 1b）。
   * 只有已发送的 text、image、file；撤回、删除的消息和提示行不能。myRole 不传时用会话列表里的角色。
   */
  canRecall(m: Message, myRole?: GroupRole): boolean {
    if (m.status !== 'sent' || !m.msgId || m.deleted) return false;
    if (m.type !== 'text' && m.type !== 'image' && m.type !== 'file') return false;
    const group = m.convId.startsWith('group:');
    const role = group ? (myRole ?? this.store.conversation(m.convId)?.myRole) : undefined;
    const manager = role === 'owner' || role === 'admin';
    let window: number;
    if (m.from === this.self) window = manager ? Math.max(RECALL_WINDOW_MS, GROUP_RECALL_WINDOW_MS) : RECALL_WINDOW_MS;
    else if (group && manager) window = GROUP_RECALL_WINDOW_MS;
    else return false;
    return this.serverNow() - m.ts <= window;
  }

  /**
   * 长按菜单里由 SDK 判断的项（F-RCL-03 规则 6）：撤回、删除的消息和提示行没有菜单（空数组，AC-RCL-03-10）。
   * 复制只有文本；引用要已发送的 text、image、file（F-QUO-01 规则 5）；撤回按 canRecall。
   * 服务端关了 msgActions（GET /v1/config 的 features）时页面只留"复制"。
   */
  messageActions(m: Message, myRole?: GroupRole): MessageAction[] {
    if (m.deleted || m.type === 'tip') return [];
    const out: MessageAction[] = [];
    if (m.type === 'text') out.push('copy');
    if (m.status === 'sent' && m.msgId && (m.type === 'text' || m.type === 'image' || m.type === 'file')) {
      out.push('quote');
    }
    if (this.canRecall(m, myRole)) out.push('recall');
    return out;
  }

  /**
   * 撤回文案要的判断数据（F-RCL-02 规则 1a，聊天页和列表摘要同一张表）：单聊 / 群、操作者是不是自己、被撤回的是不是自己的。
   * m 是消息，或会话的 lastMsg。不是撤回的返回 null（后台删除显示"该消息已被删除"）。
   */
  recallNotice(convId: string, m: Pick<Message, 'from' | 'recalled' | 'recalledBy'> | LastMsg): RecallNotice | null {
    return recallNoticeOf(convId, m, this.self);
  }

  /** 撤回文案（F-RCL-02 规则 1a 的表）：显示名按 displayName（备注只在本地显示，问题 19）。不是撤回的返回 null。 */
  recallText(convId: string, m: Pick<Message, 'from' | 'recalled' | 'recalledBy'> | LastMsg): string | null {
    const n = this.recallNotice(convId, m);
    return n ? recallText(n, (u) => this.displayName(u)) : null;
  }

  /**
   * 发图片（PRD-chat 第 13.1 节，F-FILE-02、07）。先插入一条"处理中"的消息并立即返回；轮到它时（全局并发 1，
   * 同一会话按选择顺序）调用 processed 拿到处理好的图片，上传（申请 → PUT 原图、缩略图 → complete），
   * 再按文本的规则 send。文字可以越过上传中的图片（规则 5）。上传中的时间不算 10 秒发送超时（规则 8）。
   * 处理失败 error='process'；4292、4290（uploadPendingLimit）不自动重试（F-FILE-01 规则 6、6a）。
   */
  sendImage(
    convId: string,
    processed: ProcessedImage | (() => Promise<ProcessedImage>),
    opts: AttachmentOptions = {},
  ): Message {
    const src: AttachmentSource =
      typeof processed === 'function'
        ? { kind: 'image', produce: processed, onProgress: opts.onProgress }
        : { kind: 'image', image: processed, onProgress: opts.onProgress };
    const body =
      typeof processed === 'function'
        ? { image: { fileId: '' } }
        : {
            image: {
              fileId: '',
              width: processed.width,
              height: processed.height,
              size: sizeOf(processed.original.data),
              mime: processed.original.mime,
            },
          };
    return this.addAttachment(
      convId,
      'image',
      body,
      src,
      opts.signal,
      typeof processed === 'function' ? 'processing' : 'uploading',
    );
  }

  /** 发文件（F-FILE-03、07）：内容不重新编码。其余同 sendImage。 */
  sendFile(convId: string, file: FileInput, opts: AttachmentOptions = {}): Message {
    const mime = file.mime || 'application/octet-stream';
    const body = { file: { fileId: '', name: file.name, size: sizeOf(file.data), mime } };
    return this.addAttachment(
      convId,
      'file',
      body,
      { kind: 'file', file: { ...file, mime }, onProgress: opts.onProgress },
      opts.signal,
      'uploading',
    );
  }

  /**
   * 取消一条还没发出的附件（AC-FILE-02-5、AC-FILE-01-17）：中止上传，已经申请过的发 DELETE /v1/files/uploads/{id}，
   * 消息从列表消失，不发 send。已经在 send 的不能取消，返回 false。失败的附件也可以用它删除。
   */
  cancelUpload(convId: string, clientMsgId: string): boolean {
    const list = this.store.list(convId);
    const m = list.local(clientMsgId);
    if (!m || (m.type !== 'image' && m.type !== 'file')) return false;
    if (!list.removeUnsent(clientMsgId, ['processing', 'uploading', 'queued', 'failed'])) return false;
    const job = this.job;
    if (job && job.clientMsgId === clientMsgId) {
      job.abort.abort();
      this.job = null;
      if (job.fileId) void this.files?.cancelUpload(job.fileId);
      this.pumpUploads();
    } else {
      const id = m.body.image?.fileId || m.body.file?.fileId;
      if (id) void this.files?.cancelUpload(id);
    }
    this.uploadQueue = this.uploadQueue.filter((q) => q.clientMsgId !== clientMsgId);
    this.sources.delete(clientMsgId);
    this.emitMessages(convId);
    return true;
  }

  /**
   * 取下载地址（F-FILE-04）。同一个事件循环内的调用合并成一批（每批 ≤ 50），没过期的地址用缓存（AC-FILE-04-10）。
   * 已知过期的文件不发请求，直接 code=4048（AC-FILE-06-6）。地址不要持久化、打日志（规则 5）。
   */
  async getFileUrls(items: readonly FileUrlItem[]): Promise<FileUrlResult[]> {
    const files = this.requireFiles();
    const ask = items.filter((i) => !this.store.fileExpired(i.fileId));
    const got = ask.length ? await files.getFileUrls(ask) : [];
    let k = 0;
    return items.map((i) => (this.store.fileExpired(i.fileId) && !ask.includes(i) ? { ...i, code: 4048 } : got[k++]!));
  }

  /**
   * 下载原文件要用的地址（F-FILE-03 规则 3、4）：和 getFileUrls 一样（已知过期直接 code=4048，不发请求），
   * 但取地址期间所在消息被撤回、删除或文件过期时抛 DownloadAbortedError，同时发 downloadAborted 事件（AC-RCL-03-12，
   * 和 sdk-kotlin 的 download 一致，问题 33）。地址只交给浏览器下载，不要保存、打日志。
   */
  async downloadUrl(fileId: string): Promise<FileUrlResult> {
    const item: FileUrlItem = { fileId, variant: 'original' };
    if (this.store.fileExpired(fileId)) return { ...item, code: 4048 };
    let d!: PendingDownload;
    const aborted = new Promise<never>((_, reject) => {
      d = { abort: (recalled) => reject(new DownloadAbortedError(fileId, recalled)) };
    });
    let set = this.downloads.get(fileId);
    if (!set) this.downloads.set(fileId, (set = new Set()));
    set.add(d);
    try {
      const [r] = await Promise.race([this.getFileUrls([item]), aborted]);
      return r!;
    } finally {
      set.delete(d);
      if (!set.size && this.downloads.get(fileId) === set) this.downloads.delete(fileId);
    }
  }

  private downloads = new Map<string, Set<PendingDownload>>();

  private requireFiles(): FileClient {
    if (!this.files) throw new Error('files not configured: pass IMClientOptions.files');
    return this.files;
  }

  private addAttachment(
    convId: string,
    type: 'image' | 'file',
    body: Message['body'],
    src: AttachmentSource,
    signal: AbortSignal | undefined,
    status: 'processing' | 'uploading',
  ): Message {
    this.requireFiles();
    if (!this.self) throw new NotConnectedError();
    parseConvIdStrict(convId, this.self);
    const msg: Message = {
      clientMsgId: this.newId(),
      convId,
      from: this.self,
      type,
      body,
      ts: this.clock.now(),
      status,
    };
    this.store.list(convId).addLocal(msg);
    this.sources.set(msg.clientMsgId, src);
    this.emitMessages(convId);
    if (signal) {
      if (signal.aborted) this.cancelUpload(convId, msg.clientMsgId);
      else signal.addEventListener('abort', () => this.cancelUpload(convId, msg.clientMsgId), { once: true });
    }
    if (this.store.list(convId).local(msg.clientMsgId)) this.enqueueUpload(convId, msg.clientMsgId);
    return msg;
  }

  private enqueueUpload(convId: string, clientMsgId: string): void {
    this.uploadQueue.push({ convId, clientMsgId });
    this.pumpUploads();
  }

  /** 全局一个上传（F-FILE-07 规则 6），按入队顺序（规则 5）。 */
  private pumpUploads(): void {
    if (this.job) return;
    const next = this.uploadQueue.shift();
    if (!next) return;
    const job: UploadJob = { ...next, abort: new AbortController(), completed: false };
    this.job = job;
    void this.runUpload(job).finally(() => {
      if (this.job === job) this.job = null;
      this.pumpUploads();
    });
  }

  private async runUpload(job: UploadJob): Promise<void> {
    const { convId, clientMsgId } = job;
    const files = this.files!;
    const list = () => this.store.list(convId);
    const alive = () => this.job === job && !job.abort.signal.aborted && list().local(clientMsgId) !== undefined;
    const src = this.sources.get(clientMsgId);
    if (!src || !alive()) return;
    let data: { kind: 'image' | 'file'; name: string; main: UploadData; thumb?: UploadData };
    if (src.kind === 'image') {
      if (!src.image && src.produce) {
        try {
          src.image = await src.produce();
        } catch {
          if (alive()) this.failAttachment(convId, clientMsgId, 'process');
          return;
        }
        if (!alive()) return;
      }
      const img = src.image!;
      list().update(clientMsgId, {
        status: 'uploading',
        body: {
          image: {
            fileId: '',
            width: img.width,
            height: img.height,
            size: sizeOf(img.original.data),
            mime: img.original.mime,
          },
        },
      });
      data = { kind: 'image', name: img.name || 'image', main: img.original, thumb: img.thumb };
    } else {
      const f = src.file!;
      list().update(clientMsgId, { status: 'uploading' });
      data = { kind: 'file', name: f.name, main: { data: f.data, mime: f.mime || 'application/octet-stream' } };
    }
    this.emitMessages(convId);
    const total = sizeOf(data.main.data) + (data.thumb ? sizeOf(data.thumb.data) : 0);
    const signal = job.abort.signal;
    try {
      const up = await files.createUpload(
        {
          kind: data.kind,
          name: data.name,
          size: sizeOf(data.main.data),
          mime: data.main.mime,
          ...(data.thumb ? { thumb: { size: sizeOf(data.thumb.data), mime: data.thumb.mime } } : {}),
        },
        signal,
      );
      job.fileId = up.fileId;
      if (!alive()) return;
      const mainSize = sizeOf(data.main.data);
      await files.put(up.put, data.main.data, signal, (n) => src.onProgress?.(n, total));
      if (data.thumb) {
        if (!up.thumbPut) throw new UploadPutError(0);
        if (!alive()) return;
        await files.put(up.thumbPut, data.thumb.data, signal, (n) => src.onProgress?.(mainSize + n, total));
      }
      if (!alive()) return;
      const done = await files.complete(up.fileId, signal);
      job.completed = true;
      this.ownFileIds.add(done.fileId);
      if (!alive()) return;
      const m = list().local(clientMsgId)!;
      const body: Message['body'] =
        data.kind === 'image'
          ? {
              image: {
                ...m.body.image,
                fileId: done.fileId,
                size: done.size,
                mime: done.mime,
                ...(done.width ? { width: done.width, height: done.height } : {}),
              },
            }
          : { file: { ...m.body.file, fileId: done.fileId, size: done.size, mime: done.mime } };
      // 待发送（规则 1）：在线就发，否则排队，连上后按现有规则自动发一次（规则 3）。
      if (this.conn.state === 'connected') {
        list().update(clientMsgId, { body });
        this.dispatch(convId, clientMsgId);
      } else {
        list().update(clientMsgId, { body, status: 'queued' });
        this.emitMessages(convId);
      }
    } catch (err) {
      if (!alive()) return;
      // 没完成的上传尽力取消，立刻释放未完成名额（F-FILE-01 规则 6a）。
      if (job.fileId && !job.completed) void files.cancelUpload(job.fileId);
      if (err instanceof AccountError || err instanceof IMError) {
        this.failAttachment(convId, clientMsgId, err.code, err instanceof AccountError ? err.reason : undefined);
      } else {
        this.failAttachment(convId, clientMsgId, 'network');
      }
    }
  }

  private failAttachment(convId: string, clientMsgId: string, error: MessageError, reason?: string): void {
    const list = this.store.list(convId);
    const m = list.local(clientMsgId);
    if (!m || m.seq !== undefined || m.status === 'failed') return;
    list.update(clientMsgId, { status: 'failed', error, errorReason: reason });
    this.emitMessages(convId);
    this.emit('sendFailed', convId, clientMsgId, error);
  }

  /** 附件消息还没有 fileId（没上传完）。 */
  private needsUpload(m: Message): boolean {
    return (m.type === 'image' && !m.body.image?.fileId) || (m.type === 'file' && !m.body.file?.fileId);
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

  /**
   * 手动重发失败的消息，沿用原来的 clientMsgId（PRD F-MSG-03 规则 2）。
   * 附件（F-FILE-07 规则 4）：已经 complete 的复用同一 fileId，不重传（AC-FILE-07-2）；没上传完的从头上传（新的 fileId）；
   * 源已经不在的不动，error 改成 sourceMissing（"原文件已不可用，请重新选择"，只能删除）。
   */
  retry(convId: string, clientMsgId: string): void {
    const m = this.store.list(convId).local(clientMsgId);
    if (!m || m.status !== 'failed') return;
    if (this.needsUpload(m)) {
      const src = this.sources.get(clientMsgId);
      if (!src) {
        this.store.list(convId).update(clientMsgId, { error: 'sourceMissing', errorReason: undefined });
        this.emitMessages(convId);
        return;
      }
      this.store.list(convId).update(clientMsgId, {
        status: src.image || src.file ? 'uploading' : 'processing',
        error: undefined,
        errorReason: undefined,
      });
      this.emitMessages(convId);
      this.enqueueUpload(convId, clientMsgId);
      return;
    }
    if (this.conn.state === 'connected') {
      this.dispatch(convId, clientMsgId);
    } else {
      this.autoUsed.add(clientMsgId); // 手动重发也只自动补发一次
      this.store.list(convId).update(clientMsgId, { status: 'queued', error: undefined, errorReason: undefined });
      this.emitMessages(convId);
    }
  }

  /**
   * 从本地移除一条失败的消息（PRD-ui G-UI-14）：不发任何帧，不影响服务端。
   * 只对 failed 状态有效，否则不动并返回 false。移除后 pendingCount 减 1，本次登录内不再出现。
   */
  removeFailed(convId: string, clientMsgId: string): boolean {
    if (!this.store.list(convId).removeFailed(clientMsgId)) return false;
    this.sources.delete(clientMsgId);
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
    let convs: ServerConversation[] | null = null;
    try {
      const ack = await this.conn.request<ConvsAck>('convs', {});
      convs = ack.convs;
      this.applyConvs(ack);
      for (const c of ack.convs) await this.catchUp(c);
      this.maybeReportRead();
    } catch (err) {
      this.log.warn(`im: initial sync failed: ${String(err)}`);
    }
    // 先 convs，再从本地 socialVer 开始一轮关系同步（F-SOC-06 规则 10）。
    this.social.needSync = true;
    void this.syncSocial();
    void this.recheckDeleted(convs);
  }

  /**
   * 重连后重拉已加载的范围（F-RCL-03 规则 2）：只重拉 modVer 变了的会话（文件过期等），没变的不拉。
   * 服务端没有 modVer（老服务端）或这次没拿到会话列表时，按原来的做法全部重拉：断开期间被删除的消息
   * 不会再发 msgDeleted，只有 sync 才能拿到（F-ADM-31 规则 5）。首次连接没有已加载的消息，不发请求。
   * 按会话依次重拉；一个失败只影响它自己（P-39 ②）：不记新的 modVer，下次重连再拉，其余会话照拉。
   */
  private async recheckDeleted(convs: ServerConversation[] | null): Promise<void> {
    const byId = new Map((convs ?? []).map((c) => [c.convId, c]));
    for (const { convId, from, to } of this.store.loadedRanges()) {
      const ver = byId.get(convId)?.modVer;
      if (convs && byId.has(convId) && ver !== undefined && this.modVers.get(convId) === ver) continue;
      try {
        if (await this.syncAfter(convId, from - 1, to)) {
          this.emitMessages(convId);
          this.emitConversations();
        }
        if (ver !== undefined) this.modVers.set(convId, ver);
      } catch (err) {
        this.log.warn(`im: recheck deleted failed: ${String(err)}`);
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
        // 另一端已读：提及数本地推算不了（不知道已读位置前后各有几条提及），有提及时重新拉 convs（F-MEN-03 规则 1）。
        if (this.hasMentions(ev.convId)) this.refreshMentions();
        if (this.store.advanceRead(ev.convId, ev.readSeq)) this.emitConversations();
        return;
      case 'groupChanged':
        this.onGroupChanged(ev.groupId);
        return;
      case 'msgDeleted':
        this.onMsgDeleted(ev.convId, ev.msgIds ?? [], ev.seqs ?? [], recalledOf(ev.recalled));
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
      case 'convSettingsChanged': {
        // 其他端改的：以事件为准覆盖本地（AC-CVS-04-1）。本地不认识的会话等下次 convs。
        const s: ConvSettings = { pinned: ev.pinned === true, notifyOff: ev.notifyOff === true };
        if (s.pinned && typeof ev.pinnedAt === 'number') s.pinnedAt = ev.pinnedAt;
        if (this.store.setSettings(ev.convId, s)) this.emitConversations();
        return;
      }
      case 'convDeleted':
        if (typeof ev.clearedSeq === 'number') this.onConvCleared(ev.convId, ev.clearedSeq);
        return;
      // 不认识的事件类型忽略（协议 README 第 3 节规则 9）。
    }
  }

  /**
   * 消息被删除（PRD-admin F-ADM-31）或撤回（recall 不为空，PRD-chat F-RCL-03 规则 1）：清除内存里的原文和引用它的原文，
   * 摘要改成占位，未读不变；文件通过 filesExpired 让页面丢掉缓存（规则 3）。这个会话有提及我的未读时重新拉 convs（F-MEN-03 规则 1）。
   * 还有没拿到 ack 的本地消息时（超时标记失败、ack 丢了），被删的可能正是其中一条：事件里只有 msgId 和 seq，
   * 要向服务端补拉才能按 clientMsgId 对上，并清掉发送队列里的那份原文。
   */
  private onMsgDeleted(convId: string, msgIds: string[], seqs: number[], recall?: RecallInfo): void {
    const mentioned = this.hasMentions(convId);
    this.applyDeleted(convId, msgIds, seqs, recall);
    if (mentioned) this.refreshMentions();
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

  private applyDeleted(convId: string, msgIds: string[], seqs: number[], recall?: RecallInfo): void {
    if (this.store.deleteMessages(convId, msgIds, seqs, recall)) this.emitMessages(convId);
    this.emitConversations();
  }

  private hasMentions(convId: string): boolean {
    return (this.store.conversation(convId)?.mentionUnread ?? 0) > 0;
  }

  /** 按节流重新拉 convs 更新提及数（F-MEN-03 规则 1，R-CF-18）：窗口外立即拉；窗口内只记一次，窗口结束（上次拉取后 5 秒）时补拉。 */
  private refreshMentions(): void {
    if (this.mentionTimer !== null) return;
    const wait = this.mentionFetchAt + MENTION_REFRESH_MS - this.clock.now();
    if (wait <= 0) {
      this.fetchMentions();
      return;
    }
    this.mentionTimer = this.clock.setTimeout(() => {
      this.mentionTimer = null;
      this.fetchMentions();
    }, wait);
  }

  private fetchMentions(): void {
    if (this.conn.state !== 'connected') return; // 重连时的 convs 会带最新的计数
    this.mentionFetchAt = this.clock.now();
    this.conn
      .request<ConvsAck>('convs', {})
      .then((ack) => this.applyConvs(ack))
      .catch((err) => this.log.warn(`im: mention refresh failed: ${String(err)}`));
  }

  private mentionFetchAt = -Infinity;
  private mentionTimer: TimerHandle | null = null;

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
    if (this.mentionsMe(m)) this.store.bumpMention(m.convId, m.seq);
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

  /** 群消息 @ 了我或所有人（自己发的不算，F-MEN-03 规则 6）。 */
  private mentionsMe(m: ServerMessage): boolean {
    const men = m.body?.mentions;
    if (!men || m.deleted || m.from === this.self || !m.convId.startsWith('group:')) return false;
    return men.all === true || (men.userIds ?? []).includes(this.self);
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
    const deleted = ack.deleted ?? [];
    const gone = this.store.setConversations(ack.convs, ack.truncated, deleted, ack.deletedTruncated === true);
    // 物理清除 seq < minSeq 的本地消息（F-CVS-03 规则 6 ②）：deleted 里的按 clearedSeq + 1，列表里的按 minSeq。
    for (const d of deleted) if (this.store.purgeConversation(d.convId, d.clearedSeq + 1)) this.emitMessages(d.convId);
    for (const c of ack.convs) if (this.store.purgeConversation(c.convId, c.minSeq)) this.emitMessages(c.convId);
    this.lastRefreshAt = this.clock.now();
    for (const c of ack.convs) {
      // 还没加载过消息的会话：之后加载到的就是这个版本以后的内容，记下作为基线。已加载的等重拉成功再更新。
      if (c.modVer !== undefined && !this.store.loadedRanges().some((r) => r.convId === c.convId)) {
        this.modVers.set(c.convId, c.modVer);
      }
      this.setGroupMute(c.convId, c.mutedUntil, c.allMuted);
      // 错过了 msgDeleted 的话，摘要是唯一的线索：本地已加载的那条也要清掉。带 recalled 的直接按撤回清
      // （单调，只能从假变真；和 sdk-kotlin 一致，frontend-chat 问题 32）。
      const last = c.lastMsg;
      const recall: RecallInfo | undefined = last?.recalled === true ? { by: last.recalledBy ?? '' } : undefined;
      if (last?.deleted && this.store.deleteMessages(c.convId, [last.msgId], [], recall)) this.emitMessages(c.convId);
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
    for (const m of pending) this.dropUploadJob(m.clientMsgId);
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
    // 附件只发 fileId，其他字段由服务端按记录填写（F-FILE-02 规则 1）。
    const wire =
      type === 'image'
        ? { image: { fileId: m.body.image!.fileId } }
        : type === 'file'
          ? { file: { fileId: m.body.file!.fileId } }
          : type === 'text'
            ? textWire(m.body)
            : m.body;
    const onAck = (ack: SendAck) => {
      this.sources.delete(clientMsgId); // 已发送：释放源（F-FILE-07 规则 2）
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
        { convType, to, clientMsgId, type: m.type, body: wire },
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
        if (
          err instanceof IMError &&
          (type === 'image' || type === 'file') &&
          this.purgedOnServer(err.code, list.local(clientMsgId)!)
        ) {
          this.reupload(convId, clientMsgId);
          return;
        }
        if (err instanceof IMError) this.fail(convId, clientMsgId, err.code, err.reason);
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

  /**
   * send 的错误是不是"文件已被清理"（F-FILE-07 规则 4）：4096；或者 4048 且 fileId 是这台设备自己上传得到的
   * （24 小时没绑定的上传被 file_purge 删了行，服务端分不清，v1.4，P-37 ①）。别人的 fileId（转发等）回 4048 照常失败。
   */
  private purgedOnServer(code: number, m: Message): boolean {
    if (code === ErrorCode.FILE_NOT_READY) return true;
    if (code !== ErrorCode.FILE_NOT_FOUND) return false;
    const fileId = m.body.image?.fileId || m.body.file?.fileId;
    return !!fileId && this.ownFileIds.has(fileId);
  }

  /**
   * send 返回 4096（文件超过 24 小时被清理，或已绑定别的消息），或自己上传的 fileId 返回 4048：有源的回到上传中、从头上传，不算自动重发次数（RC2-23）；
   * 没有源的转失败，error=sourceMissing（F-FILE-07 规则 4，AC-FILE-07-10）。
   */
  private reupload(convId: string, clientMsgId: string): void {
    const list = this.store.list(convId);
    const m = list.local(clientMsgId)!;
    const body: Message['body'] = m.body.image
      ? { image: { ...m.body.image, fileId: '' } }
      : { file: { ...m.body.file, fileId: '' } };
    if (!this.sources.has(clientMsgId)) {
      list.update(clientMsgId, { status: 'sending', body });
      this.fail(convId, clientMsgId, 'sourceMissing');
      return;
    }
    list.update(clientMsgId, { status: 'uploading', body, error: undefined, errorReason: undefined });
    this.emitMessages(convId);
    this.enqueueUpload(convId, clientMsgId);
  }

  private fail(convId: string, clientMsgId: string, error: Message['error'], reason?: string): void {
    const m = this.store.list(convId).local(clientMsgId);
    if (!m || m.status !== 'sending') return; // 已经被晚到的 ack 更新为已发送
    this.store.list(convId).update(clientMsgId, { status: 'failed', error, errorReason: reason });
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
    this.store.clearMentions(convId);
    this.emitConversations();
    this.conn.request('read', { convId, seq: latest }).catch((err) => this.log.warn(`im: read failed: ${String(err)}`));
  }

  // ---- 其他 ----

  /**
   * 总未读（F-CVS-02 规则 4）：普通会话的 unread 之和 + 免打扰会话的 mentionUnread 之和（@ 我计入）。
   * 标签角标、document.title 用它（AC-CVS-02-2、02-5）。
   */
  totalUnread(): number {
    return this.store
      .conversations()
      .reduce((n, c) => n + (c.notifyOff === true ? (c.mentionUnread ?? 0) : c.unread), 0);
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
    const recalled = this.store.takeRecalledFiles();
    const expired = this.store.takeExpiredFiles();
    if (expired.length) {
      for (const id of expired) this.files?.forget(id);
      for (const id of expired) {
        const running = this.downloads.get(id);
        if (!running) continue;
        this.downloads.delete(id);
        for (const d of running) d.abort(recalled.has(id));
        this.emit('downloadAborted', id, recalled.has(id));
      }
      this.emit('filesExpired', expired);
    }
  }

  /** 中止这条消息的上传（排队的也拿掉）。没完成的发 DELETE。 */
  private dropUploadJob(clientMsgId: string): void {
    this.uploadQueue = this.uploadQueue.filter((q) => q.clientMsgId !== clientMsgId);
    const job = this.job;
    if (job?.clientMsgId !== clientMsgId) return;
    job.abort.abort();
    this.job = null;
    if (job.fileId && !job.completed) void this.files?.cancelUpload(job.fileId);
    this.pumpUploads();
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
    if (this.mentionTimer !== null) this.clock.clearTimeout(this.mentionTimer);
    this.mentionTimer = null;
    this.mentionFetchAt = -Infinity;
    this.store = new Store(() => this.self);
    this.pushes.logout();
    this.mutes.clear();
    this.mutesChanged();
    this.clearSocial();
    this.knownLists.clear();
    this.autoUsed.clear();
    // 退出登录：上传中止，源和地址都只在内存里，丢掉（F-FILE-07 规则 2）。
    this.uploadQueue = [];
    if (this.job) {
      this.job.abort.abort();
      if (this.job.fileId && !this.job.completed) void this.files?.cancelUpload(this.job.fileId);
    }
    this.job = null;
    this.sources.clear();
    this.ownFileIds.clear();
    this.files?.clear();
    this.modVers.clear();
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

  /**
   * 搜索群成员（@ 选人，PRD-chat F-MEN-01 规则 6）：keyword 是 userId 前缀（区分大小写）或昵称前缀（ASCII 不区分大小写），
   * 空串等于不搜索。每人每分钟 30 次（4290），不自动重试，抛 IMError 给页面。资料写进缓存。
   */
  async searchGroupMembers(
    groupId: string,
    keyword: string,
    cursor?: string,
  ): Promise<{ members: GroupMemberInfo[]; nextCursor: string }> {
    const ack = await this.conn.request<{ members: GroupMemberInfo[]; nextCursor: string }>('groupMembers', {
      groupId,
      ...(keyword ? { keyword } : {}),
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

/** 上行的文本 body：引用只发 msgId（下行的 seq、state、text 都不发，Schema 不允许）。 */
function textWire(body: Message['body']): Record<string, unknown> {
  const out: Record<string, unknown> = { text: body.text };
  if (body.quote) out.quote = { msgId: body.quote.msgId };
  if (body.mentions) out.mentions = body.mentions;
  return out;
}

/** userIds 去重、去空；什么都没有时返回 undefined（Schema 不允许空的 mentions）。 */
function normalizeMentions(m: Mentions | undefined): Mentions | undefined {
  if (!m) return undefined;
  const userIds = [...new Set((m.userIds ?? []).filter((u) => u))];
  const out: Mentions = {};
  if (userIds.length) out.userIds = userIds;
  if (m.all === true) out.all = true;
  return out.userIds || out.all ? out : undefined;
}

function recalledOf(r: { by?: unknown; at?: unknown } | undefined): RecallInfo | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const out: RecallInfo = { by: typeof r.by === 'string' ? r.by : '' };
  if (typeof r.at === 'number') out.at = r.at;
  return out;
}
