import {
  ACCOUNT_REQUEST_TIMEOUT_MS,
  classifyRefreshFailure,
  isLocalNewer,
  kickEndsSession,
  kickIsHoldable,
  kickOutcome,
  lineageOf,
  REFRESH_BELOW_MS,
  shouldRefresh,
  type RefreshFailure,
  type RefreshSource,
  type SessionOutcome,
  type TokenLineage,
} from './account-policy.js';
import { realClock, type Clock, type TimerHandle } from './clock.js';
import { Emitter } from './emitter.js';
import { IMError } from './errors.js';
import { FetchHttpTransport, type HttpRequest, type HttpTransport } from './http.js';
import { silentLogger, type Logger } from './logger.js';
import type { Platform } from './protocol.js';
import {
  SessionEndedError,
  type KickDecision,
  type KickInfo,
  type SessionEnd,
  type TokenProvider,
} from './token-provider.js';

export { SessionEndedError };

/** 账号接口返回的错误：HTTP 状态 + {code, msg, reason?, details?}。 */
export class AccountError extends IMError {
  readonly status: number;
  readonly reason?: string;
  constructor(status: number, code: number, msg: string, reason?: string, details?: Readonly<Record<string, unknown>>) {
    super(code, msg, undefined, details);
    this.name = 'AccountError';
    this.status = status;
    this.reason = reason;
  }
}

/** 没有拿到服务端的错误码：网络不通，或者响应不是约定的 JSON（例如代理返回的 HTML）。 */
export class AccountNetworkError extends Error {
  constructor(message = 'network error') {
    super(message);
    this.name = 'AccountNetworkError';
  }
}

/** 等了 30 秒没有响应。迟到的响应会被丢弃。 */
export class AccountTimeoutError extends AccountNetworkError {
  constructor() {
    super('request timed out');
    this.name = 'AccountTimeoutError';
  }
}

/** 本地保存的会话。存储由 App 决定（H5 sessionStorage，原生 Keystore、Keychain，F-ACC-03 规则 8）。 */
export interface AccountSession {
  /** 没有 mode 的老数据按 demo（R-CF-11）。 */
  mode?: 'account' | 'demo';
  userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  refreshExpiresAt?: number;
  absoluteExpiresAt?: number;
}

/** 新 token 先写这里再使用（规则 5，R-CF-09）。确认恢复码之前不写（F-ACC-05 规则 1）。可以挂起：SDK 保证调用不重叠、按顺序执行。 */
export interface SessionStore {
  load(): Promise<AccountSession | null> | AccountSession | null;
  save(session: AccountSession): Promise<void> | void;
  clear(): Promise<void> | void;
}

export interface AuthResult {
  userId: string;
  /** 这一代恢复码要让用户保存，确认后调 ackRecoveryCode。 */
  recoveryCode?: string;
  recoveryCodeGen?: number;
  recoveryCodeUnacked?: boolean;
}

export interface AccountConfig {
  registerMode: 'closed' | 'invite' | 'open';
  demoLogin: boolean;
  features: { files: boolean };
  limits: {
    usernameMinLen: number;
    usernameMaxLen: number;
    passwordMinLen: number;
    passwordMaxLen: number;
    nicknameMaxLen: number;
    deviceNameMaxLen: number;
  };
  privacyNotice?: { version: string; url?: string };
}

export interface AccountEvents {
  events: Array<{ kind: string; at: number; platform?: Platform; ipPrefix?: string }>;
  otherSessions: { count: number; lastActiveAt?: number };
  recoveryCodeUnacked?: boolean;
}

export interface AccountClientOptions {
  /** 例如 https://im.example.com（不带 /v1）。 */
  baseUrl: string;
  platform?: Platform;
  deviceName?: string;
  store?: SessionStore;
  /** 以下用于测试注入。 */
  http?: HttpTransport;
  clock?: Clock;
  logger?: Logger;
  random?: () => number;
  /** 请求超时，默认 30 秒。 */
  requestTimeoutMs?: number;
}

type AccountClientEvents = {
  /** 会话结束，回登录页。dialog 用 sessionDialogText 取文字。 */
  ended: [SessionEnd];
  /** token 换了（已经写入 store）。不带 token 本身，要用时读 session。 */
  tokens: [];
  /** 服务端说最新一代恢复码没有确认：App 强制进保存页（F-ACC-05 规则 1）。 */
  recoveryCodeUnacked: [];
  /** 每一步判断的结果：只有动作和代号，没有凭证。调试和协议用例用。 */
  outcome: [SessionOutcome];
};

interface AuthResponse {
  userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  absoluteExpiresAt: number;
  recoveryCode?: string;
  recoveryCodeGen?: number;
  recoveryCodeUnacked?: boolean;
}

type RefreshResult = 'ok' | 'retry' | 'ended';

interface Inflight {
  attempt: number;
  abort: AbortController;
  timer: TimerHandle;
  settle: (r: RefreshResult) => void;
}

interface TokenWaiter {
  /** 什么样的 token 算等到了。 */
  rejected: Partial<TokenLineage> | null;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: TimerHandle | null;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const JITTER = 0.2;
const RETRY_AFTER_MAX_S = 600; // retryAfterSeconds 来自响应：窗口只有 2 分钟，防止一个异常值让重试永远不发生
const TIMER_MAX_MS = 86_400_000; // 超过 setTimeout 的上限会立即触发：分段等，到点再算一次
const HTTP_4011_RETRIES = 2; // 同一个请求最多因为 4011 重试这么多次

/**
 * 账号 HTTP 接口和账号会话（PRD-chat 第 13.1 节，F-ACC-03 规则 5～7、F-ACC-04 规则 3）。独立于 IMClient。
 *
 *   const account = new AccountClient({ baseUrl, platform: 'web', store });
 *   await account.login(username, password);
 *   im.connect(account.tokenProvider);
 *
 * 不变量（语义说明见 docs/sdk/README.md 第 6 节）：
 * - 同一时间最多一个刷新请求（单飞）。超时放弃之后这个序号的响应全部丢弃。
 * - 刷新、改密、找回、退出其他设备、登录、注册、注销申请排在同一个串行队列（slot）。
 * - 改密等换 sid 的操作进行中，缓存连接上的踢线，等响应再决定。
 * - token、refresh、恢复码不进 URL，不进日志，不进错误信息。
 */
export class AccountClient extends Emitter<AccountClientEvents> {
  readonly tokenProvider: TokenProvider;

  private readonly baseUrl: string;
  private readonly platform: Platform;
  private readonly deviceName?: string;
  private readonly store?: SessionStore;
  private readonly http: HttpTransport;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly random: () => number;
  private readonly timeoutMs: number;

  private session_: AccountSession | null = null;
  private lineage: TokenLineage = { sid: '', gen: 0 };
  private memoryOnly = false; // 恢复码确认之前 token 只放内存（F-ACC-05 规则 1）
  private unackedGen: number | null = null; // 只放内存时，等确认的是哪一代恢复码：确认别的代不算

  private attempt = 0;
  private inflight: Inflight | null = null;
  private superseded = 0; // 连续收到 superseded 的次数
  private backoffN = 0;
  private mustRefresh = false; // 不看剩余时间也要刷新：token 被拒绝过，或者已经过期
  private retryTimer: TimerHandle | null = null;
  /**
   * 刷新刚返回的 token 按本地时钟已经不足 6 小时（时钟偏快，或者 TTL 配得短，问题 S1）。再刷新也是同样的答案，又要重连，
   * 会一直循环到服务端限流。所以这个 token 不再主动刷新，也不按本地时间当成过期，等服务端的 4011（规则 7）。
   */
  private shortOnArrival = false;
  private rereadStore = false; // superseded 之后重读本地最新 token（规则 6）
  private lastFailure: Error | null = null;

  private slotBusy = false; // 串行队列的 slot：刷新或者队列里的操作占着
  private queue: Array<() => void> = [];
  private refreshQueued = false;
  private epoch = 0; // 每次会话结束加一：进行中的操作回来时，响应不能把已经退出的会话救回来
  private sessionSeq = 0; // 每个新会话（登录、注册、找回、restore）加一：logout 只收尾它开始时的那个会话（问题 A1）
  private logoutSeq = 0; // 每次 logout 加一：logout 之前发出的登录，响应不再采用（退出优先）
  private lastEnd: SessionEnd | null = null; // 最近一次结束的原因；有新会话时清除（问题 K7）
  private storeTail: Promise<unknown> = Promise.resolve(); // 存储按顺序执行，结束时的清除不会被更早的保存超过

  private holdDepth = 0; // 换 sid 的操作进行中（F-ACC-04 规则 3）
  private heldKicks: Array<{ info: KickInfo; resolve: (d: KickDecision) => void }> = [];
  private readonly logoutHolds = new Set<object>(); // 进行中的 logout 占的 holdDepth：新会话建立时一起放掉

  private waiters: TokenWaiter[] = [];
  private connected = false;
  private lifeTimer: TimerHandle | null = null;
  private readonly tokenListeners = new Set<() => void>();
  private readonly endedListeners = new Set<(e: SessionEnd) => void>();
  private readonly profileListeners = new Set<(userId: string, nickname: string) => void>();

  constructor(o: AccountClientOptions) {
    super();
    this.baseUrl = o.baseUrl.replace(/\/+$/, '');
    this.platform = o.platform ?? 'web';
    this.deviceName = o.deviceName;
    this.store = o.store;
    this.http = o.http ?? new FetchHttpTransport();
    this.clock = o.clock ?? realClock;
    this.log = o.logger ?? silentLogger;
    this.random = o.random ?? Math.random;
    this.timeoutMs = o.requestTimeoutMs ?? ACCOUNT_REQUEST_TIMEOUT_MS;
    this.onListenerError = (err) => this.log.error('account: listener error', err);
    this.tokenProvider = {
      accessToken: () => this.accessToken(),
      tokenRejected: (token) => this.tokenRejected(token),
      kickReceived: (info) => this.kickReceived(info),
      connectionChanged: (c) => this.connectionChanged(c),
      foreground: () => void this.foreground(),
      onTokenChanged: (fn) => subscribe(this.tokenListeners, fn),
      onEnded: (fn) => subscribe(this.endedListeners, fn),
      onProfileChanged: (fn) => subscribe(this.profileListeners, fn),
      recoveryCodeUnacked: () => this.emit('recoveryCodeUnacked'),
    };
  }

  // ---- 状态 ----

  /** 当前会话，没有时为 null。里面有 token，不要打日志。 */
  get session(): Readonly<AccountSession> | null {
    return this.session_;
  }

  /** 本地 token 的代号。会话结束后保留最后的值（只是一个数字）。 */
  get localGen(): number {
    return this.lineage.gen;
  }

  /** 有进行中的刷新请求。 */
  get refreshInflight(): boolean {
    return this.inflight !== null;
  }

  // ---- 启动和入口（规则 5） ----

  /** 启动：从 store 读会话，检查是否要刷新。已过期的先刷新，连接时 accessToken() 会等它。 */
  async start(): Promise<Readonly<AccountSession> | null> {
    const saved = await this.storeCall((st) => st.load());
    if (saved) this.restore(saved);
    if (this.session_) this.trigger('start');
    return this.session_;
  }

  /** 恢复一个已有的会话，不写 store，不发 tokens。没有 mode 的老数据按 demo（R-CF-11）。 */
  restore(saved: AccountSession): void {
    const isNew = saved.accessToken !== this.session_?.accessToken;
    if (isNew) this.sessionSeq += 1;
    this.session_ = { ...saved, mode: saved.mode ?? 'demo' };
    this.lineage = lineageOf(saved.accessToken);
    this.shortOnArrival = false;
    this.lastEnd = null;
    this.resetFailures();
    this.armLifeTimer();
    if (isNew) this.releaseLogoutHolds();
  }

  /** 回到前台。 */
  foreground(): SessionOutcome {
    return this.trigger('foreground');
  }

  /**
   * 四个入口合并成一次（单飞）。source=kicked 时 rejected 是被拒绝的 token 的身份（规则 7）。
   * 返回这一步的判断。timer 也是退避和 superseded 重试到点时走的入口。
   */
  trigger(source: RefreshSource, rejected?: Partial<TokenLineage>): SessionOutcome {
    const s = this.session_;
    if (!s) return this.record({ action: 'none' });
    if (s.mode !== 'account') {
      if (source !== 'kicked') return this.record({ action: 'none' });
      const o: SessionOutcome = { action: 'login', dialog: 'sessionExpired' };
      this.endSession({ action: 'login', dialog: 'sessionExpired', reason: 'tokenExpired', code: 4011 });
      return this.record(o);
    }
    if (source === 'kicked') {
      if (isLocalNewer(this.lineage, rejected ?? {})) return this.record({ action: 'useLocal' });
      this.mustRefresh = true;
    }
    return this.record(this.decideRefresh(source));
  }

  /**
   * /v1/* 返回 401 / 4011（规则 7、RS5-10）：本地比被拒绝的新就直接用本地值，否则刷新一次（和其他入口合并）。
   */
  http4011(rejected: Partial<TokenLineage>): SessionOutcome {
    if (isLocalNewer(this.lineage, rejected)) return this.record({ action: 'useLocal' });
    if (!this.session_) return this.record({ action: 'none' });
    this.mustRefresh = true;
    return this.record(this.decideRefresh('kicked'));
  }

  private decideRefresh(source: RefreshSource): SessionOutcome {
    if (this.inflight) return { action: 'none' };
    // 等重试时只有到点才发：superseded 要按 retryAfterSeconds（AC-ACC-03-39），退避也不提前，避免切前台刷出多个请求。
    if (this.retryTimer !== null && source !== 'timer') return { action: 'none' };
    const s = this.session_;
    if (!s) return { action: 'none' };
    if (!this.mustRefresh) {
      const now = this.clock.now();
      if (s.accessExpiresAt === s.absoluteExpiresAt && now >= s.accessExpiresAt) {
        this.endSession({ action: 'login', dialog: 'sessionExpired', reason: 'expired' });
        return { action: 'login', dialog: 'sessionExpired' };
      }
      if (this.shortOnArrival || !shouldRefresh(s.accessExpiresAt, s.absoluteExpiresAt, now)) return { action: 'none' };
    }
    if (this.slotBusy) {
      this.refreshQueued = true;
      return { action: 'none' };
    }
    this.clearRetryTimer();
    this.slotBusy = true;
    const { outcome, done } = this.beginRefresh();
    void done.then(() => this.releaseSlot());
    return outcome;
  }

  /** 发一个刷新请求。调用方负责 slot：普通刷新占整个 slot；队列内的改密在自己的 slot 里直接调（RS5-15）。 */
  private beginRefresh(): { outcome: SessionOutcome; done: Promise<RefreshResult> } {
    this.attempt += 1;
    const attempt = this.attempt;
    const abort = new AbortController();
    let settle!: (r: RefreshResult) => void;
    const done = new Promise<RefreshResult>((r) => (settle = r));
    const timer = this.clock.setTimeout(() => this.onRefreshTimeout(attempt), this.timeoutMs);
    this.inflight = { attempt, abort, timer, settle };
    void this.sendRefresh(attempt, abort);
    return { outcome: { action: 'refresh', attempt }, done };
  }

  private async sendRefresh(attempt: number, abort: AbortController): Promise<void> {
    if (this.rereadStore) await this.reloadFromStore();
    this.rereadStore = false;
    if (this.inflight?.attempt !== attempt) return;
    const refreshToken = this.session_?.refreshToken;
    if (!refreshToken) {
      this.settleRefresh(attempt, 'ended');
      this.endSession({ action: 'login', dialog: 'sessionExpired', code: 4019 });
      return;
    }
    let resp: AuthResponse;
    try {
      resp = parseAuthResponse(
        await this.send(
          'POST',
          '/v1/account/token/refresh',
          { refreshToken },
          {
            signal: abort.signal,
          },
        ),
      );
    } catch (err) {
      this.onRefreshFailed(attempt, err);
      return;
    }
    if (this.inflight?.attempt !== attempt) {
      this.log.debug(`account: late refresh response ${attempt} dropped`);
      this.record({ action: 'none' });
      return;
    }
    const next = this.sessionFrom(resp);
    try {
      if (!this.memoryOnly) await this.storeCall((st) => st.save(next)); // 新 token 先落盘再使用
    } catch (err) {
      this.log.warn(`account: session save failed: ${errName(err)}`);
      this.onRefreshFailed(attempt, new AccountNetworkError('session save failed'));
      return;
    }
    if (this.inflight?.attempt !== attempt) return; // 落盘期间超时放弃了
    this.superseded = 0;
    this.backoffN = 0;
    this.lastFailure = null;
    this.settleRefresh(attempt, 'ok');
    this.adopt(next, resp, true);
    this.record({ action: 'keepToken' });
  }

  private onRefreshTimeout(attempt: number): void {
    if (this.inflight?.attempt !== attempt) return;
    this.log.warn('account: refresh timed out');
    this.inflight.abort.abort();
    this.lastFailure = new AccountTimeoutError();
    this.scheduleBackoff();
    this.settleRefresh(attempt, 'retry');
    this.record({ action: 'backoff' });
  }

  private onRefreshFailed(attempt: number, err: unknown): void {
    if (this.inflight?.attempt !== attempt) {
      this.log.debug(`account: late refresh failure ${attempt} dropped`);
      this.record({ action: 'none' });
      return;
    }
    const failure = failureOf(err);
    this.lastFailure = err instanceof Error ? err : new AccountNetworkError();
    const o = classifyRefreshFailure(failure, this.superseded);
    this.log.warn(`account: refresh failed ${failure.code} ${failure.reason ?? ''} -> ${o.action}`);
    switch (o.action) {
      case 'backoff':
        this.scheduleBackoff();
        this.settleRefresh(attempt, 'retry');
        break;
      case 'retryAfter':
        this.superseded += 1;
        this.rereadStore = true;
        this.scheduleRetry(retryAfterMs(failure.retryAfterSeconds));
        this.settleRefresh(attempt, 'retry');
        break;
      case 'banNotice':
        this.settleRefresh(attempt, 'ended');
        this.endSession({ action: 'banNotice', code: failure.code });
        break;
      default:
        if (o.action === 'login') {
          this.settleRefresh(attempt, 'ended');
          this.endSession({
            action: 'login',
            dialog: o.dialog,
            recoverBefore: o.recoverBefore,
            reason: failure.reason,
            code: failure.code,
          });
        }
    }
    this.record(o);
  }

  private settleRefresh(attempt: number, r: RefreshResult): void {
    const f = this.inflight;
    if (f?.attempt !== attempt) return;
    this.clock.clearTimeout(f.timer);
    this.inflight = null;
    f.settle(r);
  }

  private async reloadFromStore(): Promise<void> {
    try {
      const latest = await this.storeCall((st) => st.load());
      const s = this.session_;
      if (!latest?.refreshToken || !s || latest.userId !== s.userId || latest.refreshToken === s.refreshToken) return;
      const l = lineageOf(latest.accessToken);
      if (isLocalNewer(l, this.lineage)) {
        this.session_ = { ...latest, mode: 'account' };
        this.lineage = l;
        this.shortOnArrival = false;
      }
    } catch (err) {
      this.log.warn(`account: session load failed: ${errName(err)}`);
    }
  }

  private scheduleBackoff(): void {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.backoffN, BACKOFF_MAX_MS);
    this.backoffN += 1;
    this.scheduleRetry(Math.round(base * (1 + JITTER * (2 * this.random() - 1))));
  }

  private scheduleRetry(ms: number): void {
    this.clearRetryTimer();
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = null;
      this.trigger('timer');
    }, ms);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private resetFailures(): void {
    this.superseded = 0;
    this.backoffN = 0;
    this.mustRefresh = false;
    this.rereadStore = false;
    this.lastFailure = null;
    this.clearRetryTimer();
  }

  // ---- 换 token ----

  private sessionFrom(r: AuthResponse): AccountSession {
    return {
      mode: 'account',
      userId: r.userId,
      accessToken: r.accessToken,
      accessExpiresAt: r.accessExpiresAt,
      refreshToken: r.refreshToken,
      refreshExpiresAt: r.refreshExpiresAt,
      absoluteExpiresAt: r.absoluteExpiresAt,
    };
  }

  private adopt(next: AccountSession, resp: AuthResponse, fromRefresh = false): void {
    this.session_ = next;
    this.lineage = lineageOf(next.accessToken);
    this.lastEnd = null;
    this.shortOnArrival = fromRefresh && shouldRefresh(next.accessExpiresAt, next.absoluteExpiresAt, this.clock.now());
    this.mustRefresh = false;
    this.clearRetryTimer();
    this.armLifeTimer();
    this.resolveWaiters();
    this.emit('tokens');
    for (const fn of [...this.tokenListeners]) guard(fn, this.log);
    if (resp.recoveryCodeUnacked) this.emit('recoveryCodeUnacked');
  }

  /** 登录、注册、改密、找回、退出其他设备的响应。没有恢复码才落盘；有恢复码时清掉旧的，确认之后才写（F-ACC-05 规则 1）。 */
  private async applyAuth(resp: AuthResponse, keepMemoryOnly = false): Promise<AuthResult> {
    const epoch = this.epoch;
    const next = this.sessionFrom(resp);
    this.memoryOnly = !!resp.recoveryCode || (keepMemoryOnly && this.memoryOnly);
    if (resp.recoveryCode) this.unackedGen = resp.recoveryCodeGen ?? null;
    else if (!this.memoryOnly) this.unackedGen = null;
    try {
      if (this.memoryOnly) await this.storeCall((st) => st.clear());
      else await this.storeCall((st) => st.save(next));
    } catch (err) {
      // 服务端已经换了凭证，旧 token 回不去了：继续用新的，下一次换 token 时再写。
      this.log.warn(`account: session save failed: ${errName(err)}`);
    }
    if (epoch !== this.epoch) {
      // 落盘期间退出或被踢了：这份不能留，也不能把结束的会话救回来（问题 S3，F-ACC-04 规则 1：退出优先）。
      await this.clearStore();
      throw new SessionEndedError();
    }
    this.resetFailures();
    this.adopt(next, resp);
    return {
      userId: resp.userId,
      ...(resp.recoveryCode ? { recoveryCode: resp.recoveryCode, recoveryCodeGen: resp.recoveryCodeGen } : {}),
      ...(resp.recoveryCodeUnacked ? { recoveryCodeUnacked: true } : {}),
    };
  }

  /** 已连接时的定时器（规则 5）：不足 6 小时刷新；到期等于绝对上限时不再刷新，到期回登录页（RS5-11）。 */
  private armLifeTimer(): void {
    if (this.lifeTimer !== null) this.clock.clearTimeout(this.lifeTimer);
    this.lifeTimer = null;
    const s = this.session_;
    if (!s || s.mode !== 'account' || !this.connected || this.shortOnArrival) return;
    const now = this.clock.now();
    const final = s.accessExpiresAt === s.absoluteExpiresAt;
    // 剩余恰好 6 小时不刷新，所以要过这个点 1 毫秒。
    const at = final ? s.accessExpiresAt : s.accessExpiresAt - REFRESH_BELOW_MS + 1;
    const delay = Math.max(0, at - now);
    this.lifeTimer = this.clock.setTimeout(
      () => {
        this.lifeTimer = null;
        if (delay > TIMER_MAX_MS) {
          this.armLifeTimer();
          return;
        }
        if (this.retryTimer === null) this.trigger('timer'); // 正在等重试时不提前，到点的定时器会发
      },
      Math.min(delay, TIMER_MAX_MS),
    );
  }

  private connectionChanged(connected: boolean): void {
    this.connected = connected;
    this.armLifeTimer();
  }

  // ---- token 来源（HTTP 和 WS 共用，RS5-10） ----

  private async accessToken(): Promise<string> {
    const s = this.session_;
    if (!s) throw new SessionEndedError(this.lastEnd ?? undefined);
    if (s.mode === 'account' && !this.shortOnArrival && this.clock.now() >= s.accessExpiresAt) {
      if (s.accessExpiresAt === s.absoluteExpiresAt) {
        this.endSession({ action: 'login', dialog: 'sessionExpired', reason: 'expired' });
        throw new SessionEndedError();
      }
      // 已过期：先刷新再用（规则 5）。
      const wait = this.waitForNewer(this.lineage);
      this.mustRefresh = true;
      this.record(this.decideRefresh('start'));
      await wait;
      // 不再检查一次：本地时钟走得太快时，新 token 看起来也过期了，再查就会不停刷新。
      const fresh = this.session_ as AccountSession | null;
      if (!fresh) throw new SessionEndedError();
      return fresh.accessToken;
    }
    if (s.mode === 'account') this.trigger('start');
    const now = this.session_;
    if (!now) throw new SessionEndedError();
    return now.accessToken;
  }

  private async tokenRejected(token: string): Promise<void> {
    const rejected = lineageOf(token);
    const wait = this.waitForNewer(rejected);
    this.trigger('kicked', rejected);
    await wait;
  }

  private waitForNewer(rejected: Partial<TokenLineage>, timeoutMs?: number): Promise<void> {
    if (!this.session_) return Promise.reject(new SessionEndedError());
    if (isLocalNewer(this.lineage, rejected)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const w: TokenWaiter = { rejected, resolve, reject, timer: null };
      if (timeoutMs !== undefined) {
        w.timer = this.clock.setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(this.lastFailure ?? new AccountTimeoutError());
        }, timeoutMs);
      }
      this.waiters.push(w);
    });
  }

  private resolveWaiters(): void {
    const ready = this.waiters.filter((w) => isLocalNewer(this.lineage, w.rejected ?? {}));
    this.waiters = this.waiters.filter((w) => !ready.includes(w));
    for (const w of ready) {
      if (w.timer !== null) this.clock.clearTimeout(w.timer);
      w.resolve();
    }
  }

  // ---- 踢线（F-ACC-04 规则 3，RS5-15） ----

  private kickReceived(info: KickInfo): KickDecision | Promise<KickDecision> {
    // 旧 sid 的踢线（问题 K5）：拨号读到旧 token、还没开连接时换了 sid，那条连接没有被"token 换了"断开。
    if (info.sid && this.session_ && info.sid !== this.lineage.sid) {
      this.log.debug('account: kick of an old sid ignored');
      return 'ignore';
    }
    if (this.holdDepth > 0 && kickIsHoldable(info.reason, info.code)) {
      this.log.debug('account: kick held while credentials are changing');
      return new Promise((resolve) => this.heldKicks.push({ info, resolve }));
    }
    this.applyKick(info);
    return 'pass';
  }

  private applyKick(info: KickInfo): void {
    if (!this.session_ || !kickEndsSession(info.reason, info.code)) return;
    const o = kickOutcome(info.reason, info.recoverBefore);
    this.endSession({
      action: 'login',
      ...(o.action === 'login' ? { dialog: o.dialog, recoverBefore: o.recoverBefore } : {}),
      reason: info.reason ?? undefined,
      code: info.code,
      origin: 'kick',
    });
  }

  /** 换 sid 的操作结束：成功时旧 sid 的踢线作废，失败或超时才生效（RS5-15）。 */
  private releaseHeld(succeeded: boolean): void {
    this.holdDepth -= 1;
    if (this.holdDepth > 0) return;
    const held = this.heldKicks;
    this.heldKicks = [];
    for (const { info, resolve } of held) {
      if (succeeded) {
        resolve('ignore');
      } else {
        this.applyKick(info);
        resolve('pass');
      }
    }
  }

  /** 新会话建立了：进行中的 logout 只关旧会话的事。旧连接已经随"token 换了"断开，它缓存的踢线作废，新会话的踢线不再等它。 */
  private releaseLogoutHolds(): void {
    this.holdDepth -= this.logoutHolds.size;
    this.logoutHolds.clear();
    if (this.holdDepth > 0) return;
    const held = this.heldKicks;
    this.heldKicks = [];
    for (const { resolve } of held) resolve('ignore');
  }

  // ---- 串行队列（RS4-03） ----

  /** 排进串行队列。hold：进行中缓存踢线。 */
  private enqueue<T>(fn: () => Promise<T>, hold = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        if (hold) this.holdDepth += 1;
        let ok = false;
        fn()
          .then((v) => {
            ok = true;
            resolve(v);
          }, reject)
          .finally(() => {
            if (hold) this.releaseHeld(ok);
            this.releaseSlot();
          });
      };
      if (this.slotBusy) {
        this.queue.push(run);
        return;
      }
      this.slotBusy = true;
      run();
    });
  }

  private releaseSlot(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.slotBusy = false;
    if (this.refreshQueued) {
      this.refreshQueued = false;
      if (this.retryTimer === null) this.trigger('timer'); // 正在等重试时不提前，到点的定时器会发
    }
  }

  /** 登录、注册、找回：建立新会话。logout 进行中也可以用，它结束时不碰这个新会话（问题 A1）。 */
  private enqueueNewSession(path: string, body: unknown, hold = false): Promise<AuthResult> {
    const logouts = this.logoutSeq;
    return this.enqueue(async () => {
      const resp = parseAuthResponse(await this.send('POST', path, body));
      if (logouts !== this.logoutSeq) throw new SessionEndedError(); // 先发的登录，之后点了退出：退出优先
      this.sessionSeq += 1;
      const result = await this.applyAuth(resp);
      this.releaseLogoutHolds();
      return result;
    }, hold);
  }

  /** 换 sid 的操作。等响应期间退出了就不用这个响应（F-ACC-04 规则 1：退出优先）。 */
  private async rotateInSlot(path: string, body: unknown): Promise<AuthResult> {
    const epoch = this.epoch;
    const resp = parseAuthResponse(await this.inSlot('POST', path, body));
    if (epoch !== this.epoch) throw new SessionEndedError();
    return this.applyAuth(resp, true); // 恢复码还没确认时，退出其他设备换来的 token 同样只放内存
  }

  /** 队列内的请求：要先刷新时直接在自己的 slot 里刷新，不重新排队，否则就等自己（RS5-15）。 */
  private async inSlot<T>(method: HttpRequest['method'], path: string, body: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      const s = this.session_;
      if (!s) throw new SessionEndedError();
      if (!this.shortOnArrival && this.clock.now() >= s.accessExpiresAt) await this.refreshInSlot();
      const token = this.session_?.accessToken;
      if (!token) throw new SessionEndedError();
      try {
        return await this.sendAuthed<T>(method, path, body, token);
      } catch (err) {
        if (i >= HTTP_4011_RETRIES || !is4011(err)) throw err;
        const out = this.record(
          isLocalNewer(this.lineage, lineageOf(token)) ? { action: 'useLocal' } : { action: 'none' },
        );
        if (out.action !== 'useLocal') await this.refreshInSlot();
      }
    }
  }

  private async refreshInSlot(): Promise<void> {
    this.clearRetryTimer();
    this.mustRefresh = true;
    const { outcome, done } = this.beginRefresh();
    this.record(outcome);
    const r = await done;
    if (r === 'ended') throw new SessionEndedError();
    if (r === 'retry') throw this.lastFailure ?? new AccountNetworkError();
  }

  // ---- 账号接口 ----

  /** GET /v1/config。失败时不猜测模式，由调用方处理（F-ACC-07 规则 4）。 */
  getConfig(): Promise<AccountConfig> {
    return this.send<AccountConfig>('GET', '/v1/config');
  }

  register(input: { username: string; password: string; nickname?: string; inviteCode?: string }): Promise<AuthResult> {
    return this.enqueueNewSession('/v1/account/register', { ...input, ...this.deviceFields() });
  }

  login(username: string, password: string): Promise<AuthResult> {
    return this.enqueueNewSession('/v1/account/login', { username, password, ...this.deviceFields() });
  }

  /** 找回（F-ACC-05）。成功后换 sid，响应带新恢复码。 */
  recover(username: string, recoveryCode: string, newPassword: string): Promise<AuthResult> {
    return this.enqueueNewSession(
      '/v1/account/recover',
      { username, recoveryCode, newPassword, ...this.deviceFields() },
      true,
    );
  }

  /** 主动刷新一次（和其他入口合并）。token 换了才 resolve；30 秒内没换上时 reject，后台还会按规则继续重试。 */
  async refresh(): Promise<void> {
    if (this.session_?.mode !== 'account') throw new SessionEndedError();
    const wait = this.waitForNewer(this.lineage, this.timeoutMs);
    this.mustRefresh = true;
    this.record(this.decideRefresh('foreground'));
    await wait;
  }

  /** 改密（F-ACC-04 规则 3）：进行中缓存踢线，成功先换 token（新 sid），再忽略旧 sid 的踢线；失败或超时才按踢线处理。 */
  changePassword(oldPassword: string, newPassword: string): Promise<AuthResult> {
    return this.enqueue(() => this.rotateInSlot('/v1/account/password', { oldPassword, newPassword }), true);
  }

  /** 退出其他设备（F-ACC-04 规则 6）：同改密的换 sid，不改密码。 */
  logoutOthers(password: string): Promise<AuthResult> {
    return this.enqueue(() => this.rotateInSlot('/v1/account/logout-others', { password }), true);
  }

  /**
   * 退出（F-ACC-04 规则 1）：先通知服务端，再清本地；连不上也本地退出。resolve 的值表示服务端确认了。
   * 进行中的刷新作废，排队的操作失败。H5 的"待退出"不适用（FE-610 第 6 条）；原生端在 FE-611、FE-612 实现。
   * 只收尾开始时的那个会话：等响应期间登录成功的新会话不受影响，也没有 ended（问题 A1）。
   */
  async logout(): Promise<boolean> {
    const s = this.session_;
    if (!s) return true;
    this.epoch += 1; // 等 logout 响应时回来的响应不能再采用
    this.logoutSeq += 1;
    const seq = this.sessionSeq;
    this.abandonRefresh();
    let confirmed = s.mode !== 'account';
    if (s.mode === 'account') {
      const hold = {};
      this.logoutHolds.add(hold);
      this.holdDepth += 1;
      try {
        await this.send('POST', '/v1/account/logout', { refreshToken: s.refreshToken }, { bearer: s.accessToken });
        confirmed = true;
      } catch (err) {
        this.log.warn(`account: logout not confirmed: ${errName(err)}`);
      }
      if (this.logoutHolds.delete(hold)) this.holdDepth -= 1;
    }
    if (seq === this.sessionSeq) this.endSession({ action: 'logout' });
    await this.storeTail; // 返回时 token 已经不在存储里
    return confirmed;
  }

  /** 重新生成恢复码（F-ACC-05 规则 5）。token 不变。 */
  async regenerateRecoveryCode(password: string): Promise<{ recoveryCode: string; recoveryCodeGen: number }> {
    const r = await this.authed<{ recoveryCode: string; recoveryCodeGen: number }>(
      'POST',
      '/v1/account/recovery-code',
      { password },
    );
    // 还只放内存时要确认的就是这一代。响应可能比之后的改密晚到：代号只进不退。
    if (this.memoryOnly) this.unackedGen = Math.max(this.unackedGen ?? 0, r.recoveryCodeGen);
    return r;
  }

  /**
   * 确认已保存恢复码。确认前只放内存的 token 这时才落盘。
   * 收到 recoveryCodeStale：恢复码已更新，会话结束，回登录页（AC-ACC-05-15）。
   */
  async ackRecoveryCode(gen: number): Promise<void> {
    try {
      await this.authed('POST', '/v1/account/recovery-code/ack', { gen });
    } catch (err) {
      if (err instanceof AccountError && err.reason === 'recoveryCodeStale') {
        this.endSession({ action: 'login', dialog: 'recoveryCodeStale', reason: err.reason, code: err.code });
      }
      throw err;
    }
    // 确认的是旧的一代（确认进行中改密、找回或重新生成换了代）：这一代的新 token 还不能落盘（RS5-13）。
    // 写到"存的就是在用的"才清标记：写的时候刷新还是只放内存，写失败抛给调用方，再调一次能重写（问题 S3）。
    // 写的时候会话结束：存储按顺序执行，结束时的清除排在这次写入后面，所以不用再清。
    while (this.session_ && this.memoryOnly && gen === this.unackedGen) {
      const s = this.session_;
      await this.storeCall((st) => st.save(s));
      if (s === this.session_ && gen === this.unackedGen) {
        this.memoryOnly = false;
        this.unackedGen = null;
        return;
      }
    }
  }

  /** 改资料（F-ACC-06）。本端立即显示；其他端按 10 分钟缓存更新。 */
  async updateProfile(input: { nickname?: string; avatarFileId?: string }): Promise<void> {
    await this.authed('PATCH', '/v1/account/profile', input);
    const userId = this.session_?.userId;
    if (userId && input.nickname !== undefined) {
      for (const fn of [...this.profileListeners]) guard(() => fn(userId, input.nickname as string), this.log);
    }
  }

  /** 最近登录记录和其他会话数量。 */
  async listEvents(): Promise<AccountEvents> {
    const r = await this.authed<AccountEvents>('GET', '/v1/account/events');
    if (r.recoveryCodeUnacked) this.emit('recoveryCodeUnacked');
    return r;
  }

  /** 申请注销（F-ACC-08）：成功后全部会话吊销，这里结束本地会话。进行中缓存踢线，失败才生效。 */
  requestDelete(password: string): Promise<void> {
    return this.enqueue(async () => {
      await this.inSlot('POST', '/v1/account/delete', { password });
      this.endSession({ action: 'login', reason: 'accountDeleted' });
    }, true);
  }

  /** 撤销注销：匿名接口。 */
  async cancelDelete(username: string, password: string): Promise<void> {
    await this.send('POST', '/v1/account/delete/cancel', { username, password });
  }

  private deviceFields(): { platform: Platform; deviceName?: string } {
    return { platform: this.platform, ...(this.deviceName ? { deviceName: this.deviceName } : {}) };
  }

  /** 不在队列里的带 Bearer 请求：带旧 token 得到 4011 时用本地值重试，或者等一次刷新（规则 7）。 */
  private async authed<T>(method: HttpRequest['method'], path: string, body?: unknown): Promise<T> {
    for (let i = 0; ; i++) {
      const s = this.session_;
      if (!s) throw new SessionEndedError();
      const token = await this.accessToken();
      try {
        return await this.sendAuthed<T>(method, path, body, token);
      } catch (err) {
        if (i >= HTTP_4011_RETRIES || !is4011(err)) throw err;
        const rejected = lineageOf(token);
        const wait = this.waitForNewer(rejected, this.timeoutMs);
        this.http4011(rejected);
        await wait;
      }
    }
  }

  private async sendAuthed<T>(method: HttpRequest['method'], path: string, body: unknown, token: string): Promise<T> {
    try {
      return await this.send<T>(method, path, body, { bearer: token });
    } catch (err) {
      // access 已被吊销：和连接上的 4012 一样，回登录页。token 已经不是当前的（换过 sid）就不算。
      if (
        err instanceof AccountError &&
        (err.code === 4012 || err.code === 4010) &&
        token === this.session_?.accessToken &&
        this.holdDepth === 0
      ) {
        this.endSession({ action: 'login', dialog: 'sessionExpired', code: err.code });
      }
      throw err;
    }
  }

  /** 发一个请求。超时用 Clock；路径里没有凭证；日志只有方法、路径和错误码。 */
  private send<T>(
    method: HttpRequest['method'],
    path: string,
    body?: unknown,
    opts: { bearer?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
    const req: HttpRequest = {
      method,
      url: this.baseUrl + path,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    // 刷新有自己的超时和序号（signal），其他请求在这里定时。迟到的响应到这里就结束了，到不了调用方。
    if (opts.signal) return this.exchange<T>({ ...req, signal: opts.signal }, path);
    const abort = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.log.warn(`account: ${method} ${path} timed out`);
        abort.abort();
        reject(new AccountTimeoutError());
      }, this.timeoutMs);
      this.exchange<T>({ ...req, signal: abort.signal }, path).then(
        (v) => {
          this.clock.clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          this.clock.clearTimeout(timer);
          reject(e instanceof Error ? e : new AccountNetworkError());
        },
      );
    });
  }

  private async exchange<T>(req: HttpRequest, path: string): Promise<T> {
    let status: number;
    let text: string;
    try {
      ({ status, text } = await this.http.request(req));
    } catch {
      throw new AccountNetworkError(); // 不带原始错误：错误信息里可能有 URL
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = undefined;
    }
    if (status >= 200 && status < 300) {
      if (data === undefined) throw new AccountNetworkError('invalid response');
      return data as T;
    }
    const e = data as { code?: unknown; msg?: unknown; reason?: unknown; details?: unknown } | undefined;
    if (typeof e?.code !== 'number') {
      this.log.warn(`account: ${req.method} ${path} status ${status}`);
      throw new AccountNetworkError(`status ${status}`); // 代理返回的页面不算服务端的判断，不能据此回登录页
    }
    this.log.debug(`account: ${req.method} ${path} ${status} ${e.code}`);
    throw new AccountError(
      status,
      e.code,
      typeof e.msg === 'string' ? e.msg : '',
      typeof e.reason === 'string' ? e.reason : undefined,
      typeof e.details === 'object' && e.details !== null ? (e.details as Record<string, unknown>) : undefined,
    );
  }

  // ---- 结束 ----

  private abandonRefresh(): void {
    const f = this.inflight;
    if (f) {
      f.abort.abort();
      this.settleRefresh(f.attempt, 'ended');
    }
  }

  /** 清掉本地凭证，告诉所有等待的人。localGen 保留。 */
  private endSession(e: SessionEnd): void {
    if (!this.session_) return;
    this.epoch += 1;
    this.session_ = null;
    this.memoryOnly = false;
    this.unackedGen = null;
    this.shortOnArrival = false;
    this.lastEnd = stripUndefined(e);
    this.abandonRefresh();
    this.resetFailures();
    this.refreshQueued = false;
    if (this.lifeTimer !== null) this.clock.clearTimeout(this.lifeTimer);
    this.lifeTimer = null;
    void this.clearStore();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      if (w.timer !== null) this.clock.clearTimeout(w.timer);
      w.reject(new SessionEndedError());
    }
    const held = this.heldKicks;
    this.heldKicks = [];
    // 已经结束了：缓存的踢线不用再处理，连接停在 stop 或者随后的 fatal。
    for (const { resolve } of held) resolve(e.action === 'logout' ? 'ignore' : 'pass');
    const end = stripUndefined(e);
    for (const fn of [...this.endedListeners]) guard(() => fn(end), this.log);
    this.emit('ended', end);
  }

  /** 存储调用一个接一个：可以挂起的存储上，先发起的先落地。 */
  private storeCall<T>(op: (store: SessionStore) => Promise<T> | T): Promise<T | undefined> {
    const store = this.store;
    if (!store) return Promise.resolve(undefined);
    const run = this.storeTail.then(() => op(store));
    this.storeTail = run.catch(() => undefined);
    return run;
  }

  private async clearStore(): Promise<void> {
    try {
      await this.storeCall((st) => st.clear());
    } catch (err) {
      this.log.warn(`account: session clear failed: ${errName(err)}`);
    }
  }

  private record<T extends SessionOutcome>(o: T): T {
    this.emit('outcome', o);
    return o;
  }
}

function subscribe<F>(set: Set<F>, fn: F): () => void {
  set.add(fn);
  return () => set.delete(fn);
}

function guard(fn: () => void, log: Logger): void {
  try {
    fn();
  } catch (err) {
    log.error('account: listener error', err);
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'error';
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function is4011(err: unknown): boolean {
  return err instanceof AccountError && err.code === 4011;
}

function retryAfterMs(seconds: number | undefined): number {
  const s = seconds && seconds > 0 ? Math.min(seconds, RETRY_AFTER_MAX_S) : 1;
  return s * 1000;
}

/** 响应的 details 带 retryAfterSeconds、recoverBefore（server/internal/account/refresh.go）。 */
function failureOf(err: unknown): RefreshFailure {
  if (!(err instanceof AccountError)) return { code: 0 };
  const num = (k: string) => {
    const v = err.details?.[k];
    return typeof v === 'number' ? v : undefined;
  };
  return {
    code: err.code,
    reason: err.reason,
    retryAfterSeconds: num('retryAfterSeconds'),
    recoverBefore: num('recoverBefore'),
  };
}

/** 响应不完整按网络错误处理：留在当前页面，不当成服务端的判断。 */
function parseAuthResponse(v: unknown): AuthResponse {
  const r = v as Partial<AuthResponse> | null;
  if (
    !r ||
    typeof r.userId !== 'string' ||
    typeof r.accessToken !== 'string' ||
    !r.accessToken ||
    typeof r.refreshToken !== 'string' ||
    !r.refreshToken ||
    typeof r.accessExpiresAt !== 'number' ||
    typeof r.refreshExpiresAt !== 'number' ||
    typeof r.absoluteExpiresAt !== 'number'
  ) {
    throw new AccountNetworkError('invalid response');
  }
  return r as AuthResponse;
}
