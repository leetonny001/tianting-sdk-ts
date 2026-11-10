import { lineageOf } from './account-policy.js';
import type { Clock, TimerHandle } from './clock.js';
import { Emitter } from './emitter.js';
import { CLOSE_RECONNECT, IMError, KICK_CLOSE_CODE } from './errors.js';
import type { Logger } from './logger.js';
import type { AuthAck, InboundFrame, Platform } from './protocol.js';
import {
  SessionEndedError,
  type KickDecision,
  type KickInfo,
  type SessionEnd,
  type TokenProvider,
} from './token-provider.js';
import type { Transport, TransportConnection } from './transport.js';

export type ConnState = 'disconnected' | 'connecting' | 'connected';

/** 连接不再自动重连的原因：被踢（kicked 事件），或者收到不应重连的关闭码（1000、4009～4012、4429）。 */
export type FatalReason =
  /**
   * until 只在 reason = suspended 时有：封禁到期时间（毫秒），永久为 null。
   * recoverBefore：找回截止日期（PRD-chat F-ACC-03 规则 6a），有就提示这个日期，用 sessionDialogText。
   */
  | { kind: 'kicked'; reason: string; code: number; until?: number | null; recoverBefore?: number }
  | { kind: 'closed'; code: number; reason: string }
  /** 账号会话结束（connect(tokenProvider)）：刷新得到 4019，access 到达绝对上限，或者连接时会话已经结束（问题 K7）。 */
  | ({ kind: 'session' } & Omit<SessionEnd, 'origin'>);

export interface ConnectionOptions {
  /** WebSocket 地址，例如 wss://im.example.com/ws（不要带 token，C-52）。 */
  url: string;
  platform: Platform;
  transport: Transport;
  clock: Clock;
  logger: Logger;
  heartbeatMs: number;
  pongTimeoutMs: number;
  requestTimeoutMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** 退避抖动比例（0.2 表示 ±20%）。 */
  jitter: number;
  /** 返回 [0, 1) 的随机数（测试时注入固定值）。 */
  random: () => number;
}

export const DEFAULT_TIMINGS = {
  heartbeatMs: 30_000,
  pongTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  jitter: 0.2,
} as const;

type ConnEvents = {
  state: [ConnState];
  /** 每次鉴权成功（包括重连）后触发。 */
  connected: [AuthAck];
  /** 非 ack 的下行帧：msg、event（kicked 除外）。 */
  frame: [InboundFrame];
  /** 连接结束且不会再自动重连。 */
  fatal: [FatalReason];
};

/** 请求超时：ack 可能只是晚到了。 */
export class TimeoutError extends Error {
  constructor(cmd: string) {
    super(`${cmd} timed out`);
    this.name = 'TimeoutError';
  }
}

/** 请求发出后、收到 ack 之前连接断开了。 */
export class ConnectionClosedError extends Error {
  constructor() {
    super('connection closed');
    this.name = 'ConnectionClosedError';
  }
}

/** 当前没有已鉴权的连接。 */
export class NotConnectedError extends Error {
  constructor() {
    super('not connected');
    this.name = 'NotConnectedError';
  }
}

interface Pending {
  cmd: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: TimerHandle;
  timedOut: boolean;
  /** 超时之后 ack 才到达时调用（C-30：以 ack 为准）。 */
  onLateAck?: (data: unknown, err?: IMError) => void;
}

/**
 * 连接管理（FE-003）：首帧鉴权、心跳、断线重连（指数退避 + 抖动）、被踢处理、请求与 ack 匹配。
 *
 * 状态：disconnected → connecting（建立 WebSocket、发送 auth）→ connected（收到 auth 的 ack）。
 * token 只出现在 auth 帧里，不进 URL、不进日志（C-52）。
 */
export class Connection extends Emitter<ConnEvents> {
  private readonly o: ConnectionOptions;
  private token = '';
  private active = false; // start() 之后、stop() 或致命关闭之前为 true
  private stateValue: ConnState = 'disconnected';
  private conn: TransportConnection | null = null;
  private connGen = 0; // 每次拨号加一，用来忽略旧连接迟到的回调
  private attempt = 0; // 连续失败次数，用于退避；鉴权成功后清零
  private reconnectTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private pongTimer: TimerHandle | null = null;
  private kickedReason: string | null = null;
  private kickedUntil: number | null | undefined;
  private kickedRecoverBefore: number | undefined;
  private provider: TokenProvider | null = null;
  private unsubscribeToken: (() => void) | null = null;
  private rejectStreak = 0; // 连续被 4011 拒绝的次数：第一次立即重连，再来按退避，防止和服务端打转
  private reqN = 0;
  private authId = '';
  private pending = new Map<string, Pending>();

  constructor(options: ConnectionOptions) {
    super();
    this.o = options;
  }

  get state(): ConnState {
    return this.stateValue;
  }

  /**
   * 开始连接（已经在连接或已连接时只更新 token）。
   * 传字符串是演示模式，行为不变；传 TokenProvider 是账号模式（PRD-chat F-ACC-03 规则 5、7）。
   */
  start(token: string | TokenProvider): void {
    this.setProvider(typeof token === 'string' ? null : token);
    if (typeof token === 'string') this.token = token;
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.rejectStreak = 0;
    this.dial();
  }

  private setProvider(p: TokenProvider | null): void {
    if (p === this.provider) return;
    this.unsubscribeToken?.();
    this.provider = p;
    this.unsubscribeToken = p?.onTokenChanged(() => this.onTokenChanged()) ?? null;
  }

  /** token 换了（规则 5）：已有连接用 1000 断开，立即用新 token 重连；在等退避的不用等了。 */
  private onTokenChanged(): void {
    if (!this.active) return;
    const conn = this.conn;
    if (conn) {
      this.teardown();
      conn.close(1000, 'token rotated');
      this.setState('disconnected');
      this.dial();
    } else if (this.reconnectTimer !== null) {
      this.clearReconnect();
      this.dial();
    }
  }

  /** 主动退出：以 1000 关闭，不再重连（PRD F-AUTH-05）。 */
  stop(): void {
    this.active = false;
    this.clearReconnect();
    const conn = this.conn;
    this.teardown();
    conn?.close(1000, 'logout');
    this.setState('disconnected');
    this.setProvider(null);
  }

  /** 网络恢复（浏览器 online 事件）：正在等待退避时立即重连（PRD F-CONN-01 规则 3）。 */
  reconnectNow(): void {
    if (this.active && this.stateValue === 'disconnected' && this.reconnectTimer !== null) {
      this.clearReconnect();
      this.dial();
    }
  }

  /**
   * 发送请求并等待 ack。未连接时立即失败（NotConnectedError）；ack 带 error 时以 IMError 失败；
   * 超时以 TimeoutError 失败，之后 ack 若到达会调用 onLateAck。
   */
  request<T>(
    cmd: string,
    data: unknown,
    opts: { timeoutMs?: number; onLateAck?: Pending['onLateAck'] } = {},
  ): Promise<T> {
    if (this.stateValue !== 'connected' || !this.conn) return Promise.reject(new NotConnectedError());
    const id = `r${++this.reqN}`;
    const conn = this.conn;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        cmd,
        resolve: resolve as (d: unknown) => void,
        reject,
        timedOut: false,
        onLateAck: opts.onLateAck,
        timer: this.o.clock.setTimeout(() => {
          p.timedOut = true;
          reject(new TimeoutError(cmd));
          if (!p.onLateAck) this.pending.delete(id);
        }, opts.timeoutMs ?? this.o.requestTimeoutMs),
      };
      this.pending.set(id, p);
      conn.send(JSON.stringify({ id, cmd, data }));
    });
  }

  private dial(): void {
    const gen = ++this.connGen;
    this.kickedReason = null;
    this.kickedUntil = undefined;
    this.kickedRecoverBefore = undefined;
    this.setState('connecting');
    const provider = this.provider;
    if (!provider) {
      this.openSocket(gen);
      return;
    }
    // 启动已过期时这里会先刷新（规则 5）。等的时候会话才结束：IMClient 从 onEnded 收到，已经 stop，这里什么都不做。
    provider.accessToken().then(
      (token) => {
        if (gen !== this.connGen || !this.active) return;
        this.token = token;
        this.openSocket(gen);
      },
      (err: unknown) => {
        this.o.logger.debug('im: no token, session ended');
        if (gen === this.connGen && this.active && this.provider === provider) this.emitNoSession(err);
      },
    );
  }

  /** 连接时会话已经结束（问题 K7）：不会有 onEnded 了，不能停在连接中。 */
  private emitNoSession(err: unknown): void {
    const end: SessionEnd = (err instanceof SessionEndedError ? err.end : undefined) ?? { action: 'login' };
    const fatal: FatalReason = { kind: 'session', ...end };
    delete (fatal as { origin?: unknown }).origin;
    this.active = false;
    this.setState('disconnected');
    this.emit('fatal', fatal);
  }

  private openSocket(gen: number): void {
    const url = `${this.o.url}?platform=${encodeURIComponent(this.o.platform)}`;
    this.conn = this.o.transport.open(url, {
      onOpen: () => {
        if (gen !== this.connGen) return;
        this.authId = `auth${gen}`;
        // 不经过任何日志：auth 帧里有 token。
        this.conn?.send(JSON.stringify({ id: this.authId, cmd: 'auth', data: { token: this.token } }));
      },
      onMessage: (text) => {
        if (gen === this.connGen) this.onFrame(text);
      },
      onClose: (code, reason) => {
        if (gen === this.connGen) this.onClosed(code, reason);
      },
    });
  }

  private onFrame(text: string): void {
    let f: InboundFrame;
    try {
      f = JSON.parse(text) as InboundFrame;
    } catch {
      this.o.logger.warn('im: invalid frame from server');
      return;
    }
    switch (f.cmd) {
      case 'ack':
        this.onAck(f);
        return;
      case 'pong':
        this.clearPong();
        return;
      case 'event': {
        const ev = f.data as
          { type?: string; reason?: string; until?: number | null; recoverBefore?: number } | undefined;
        if (ev?.type === 'kicked') {
          // 先记下原因，等随后的关闭码到达时统一处理。
          this.kickedReason = ev.reason ?? '';
          this.kickedUntil = ev.until;
          this.kickedRecoverBefore = typeof ev.recoverBefore === 'number' ? ev.recoverBefore : undefined;
          return;
        }
        this.emit('frame', f);
        return;
      }
      default:
        this.emit('frame', f);
    }
  }

  private onAck(f: InboundFrame): void {
    if (f.id && f.id === this.authId && this.stateValue === 'connecting') {
      if (f.error) {
        this.o.logger.warn(`im: auth rejected ${f.error.code}`);
        return; // 凭证问题由服务端随后的 kicked + 关闭码处理
      }
      this.attempt = 0;
      this.rejectStreak = 0;
      this.setState('connected');
      this.scheduleHeartbeat();
      this.emit('connected', f.data as AuthAck);
      return;
    }
    const p = f.id ? this.pending.get(f.id) : undefined;
    if (!p || !f.id) return;
    this.pending.delete(f.id);
    this.o.clock.clearTimeout(p.timer);
    const err = f.error
      ? new IMError(
          f.error.code,
          f.error.msg,
          f.error.userId ?? f.error.details?.userId,
          f.error.details,
          f.error.reason,
        )
      : undefined;
    if (p.timedOut) {
      p.onLateAck?.(f.data, err);
      return;
    }
    if (err) p.reject(err);
    else p.resolve(f.data);
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = this.o.clock.setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.stateValue !== 'connected' || !this.conn) return;
      this.conn.send('{"cmd":"ping"}');
      // 10 秒收不到 pong：网络在线但服务端无响应，判定断线（AC-CONN-01-6）。
      this.pongTimer = this.o.clock.setTimeout(() => {
        this.pongTimer = null;
        this.o.logger.warn('im: pong timeout, reconnecting');
        const conn = this.conn;
        this.onClosed(1006, 'pong timeout');
        conn?.close(4000, 'pong timeout');
      }, this.o.pongTimeoutMs);
      this.scheduleHeartbeat();
    }, this.o.heartbeatMs);
  }

  private onClosed(code: number, reason: string): void {
    // 不认识的踢线原因（PRD-chat F-ACC-04 规则 5，PRD-core 3.1 节）：关闭码说可以重连就忽略它；否则按关闭码结束，原因原样告诉界面。
    const raw = this.kickedReason;
    const known = raw !== null && raw in KICK_CLOSE_CODE;
    const kicked = raw !== null && (known || CLOSE_RECONNECT[code] === false) ? raw : null;
    if (raw !== null && !known) this.o.logger.warn(`im: unknown kick reason, close code ${code}`);
    const until = this.kickedUntil;
    const recoverBefore = this.kickedRecoverBefore;
    this.teardown();
    this.setState('disconnected');
    if (!this.active) return;

    if (this.provider && this.onClosedWithProvider(this.provider, kicked, known, code, until, recoverBefore)) return;

    // 被踢不重连（PRD F-AUTH-03 规则 4），例外：服务端下线按退避重连（C-55）。
    if (kicked !== null && kicked !== 'serverShutdown') {
      this.emitKicked(kicked, code, until, recoverBefore);
      return;
    }
    // 1000、4009～4012、4429 不重连；未列出的关闭码（1006 等）按可以重连处理。
    if (kicked === null && CLOSE_RECONNECT[code] === false) {
      this.active = false;
      this.emit('fatal', { kind: 'closed', code, reason });
      return;
    }
    this.scheduleReconnect();
  }

  private emitKicked(reason: string, code: number, until: number | null | undefined, recoverBefore?: number): void {
    this.active = false;
    this.emit('fatal', {
      kind: 'kicked',
      reason,
      code,
      ...(until !== undefined ? { until } : {}),
      ...(recoverBefore !== undefined ? { recoverBefore } : {}),
    });
  }

  /** 账号模式的关闭：4011 走规则 7；4010、4012 让账号会话决定（改密进行中要缓存，F-ACC-04 规则 3）。返回 true 表示处理完了。 */
  private onClosedWithProvider(
    provider: TokenProvider,
    kicked: string | null,
    known: boolean,
    code: number,
    until: number | null | undefined,
    recoverBefore: number | undefined,
  ): boolean {
    if (kicked === 'tokenExpired' || (!known && code === 4011)) {
      this.onTokenRejected(provider);
      return true;
    }
    if (kicked === 'serverShutdown') return false;
    if (!known && code !== 4010 && code !== 4012) return false;
    const info: KickInfo = {
      reason: known ? kicked : null,
      code,
      ...(recoverBefore !== undefined ? { recoverBefore } : {}),
      sid: lineageOf(this.token).sid,
    };
    const apply = (d: KickDecision) => {
      if (!this.active || this.provider !== provider) return;
      if (d === 'ignore') {
        this.dial(); // 旧 sid 的踢线：token 已经换好了，立即重连，1 秒内不显示提示
      } else if (kicked !== null) {
        this.emitKicked(kicked, code, until, recoverBefore);
      } else {
        this.active = false;
        this.emit('fatal', { kind: 'closed', code, reason: '' });
      }
    };
    const decision = provider.kickReceived(info);
    if (typeof decision === 'string') apply(decision);
    else void decision.then(apply);
    return true;
  }

  /** 规则 7：等 token 来源给出新的（本地更新就立刻，否则刷新一次），然后重连。会话结束时 IMClient 从 onEnded 收到。 */
  private onTokenRejected(provider: TokenProvider): void {
    const gen = this.connGen;
    this.rejectStreak += 1;
    provider.tokenRejected(this.token).then(
      () => {
        if (gen !== this.connGen || !this.active || this.provider !== provider) return;
        if (this.rejectStreak <= 1) this.dial();
        else if (this.reconnectTimer === null) this.scheduleReconnect();
      },
      () => this.o.logger.debug('im: token rejected, session ended'),
    );
  }

  /** 退避：1s、2s、4s… 最长 30s（上限是加抖动之前的值，C-22），再加 ±jitter。 */
  private scheduleReconnect(): void {
    const base = Math.min(this.o.backoffBaseMs * 2 ** this.attempt, this.o.backoffMaxMs);
    const delay = Math.round(base * (1 + this.o.jitter * (2 * this.o.random() - 1)));
    this.attempt++;
    this.o.logger.debug(`im: reconnect in ${delay}ms`);
    this.reconnectTimer = this.o.clock.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.active) this.dial();
    }, delay);
  }

  /** 断开后的清理：停定时器、让所有未完成的请求失败、忽略旧连接后续的回调。 */
  private teardown(): void {
    this.connGen++;
    this.conn = null;
    if (this.heartbeatTimer !== null) this.o.clock.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.clearPong();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      this.o.clock.clearTimeout(p.timer);
      if (!p.timedOut) p.reject(new ConnectionClosedError());
    }
  }

  private clearPong(): void {
    if (this.pongTimer !== null) this.o.clock.clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) this.o.clock.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setState(s: ConnState): void {
    if (s === this.stateValue) return;
    this.stateValue = s;
    this.provider?.connectionChanged(s === 'connected');
    this.emit('state', s);
  }
}
