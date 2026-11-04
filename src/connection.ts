import type { Clock, TimerHandle } from './clock.js';
import { Emitter } from './emitter.js';
import { CLOSE_RECONNECT, IMError } from './errors.js';
import type { Logger } from './logger.js';
import type { AuthAck, InboundFrame, Platform } from './protocol.js';
import type { Transport, TransportConnection } from './transport.js';

export type ConnState = 'disconnected' | 'connecting' | 'connected';

/** 连接不再自动重连的原因：被踢（kicked 事件），或者收到不应重连的关闭码（1000、4009～4012、4429）。 */
export type FatalReason =
  { kind: 'kicked'; reason: string; code: number } | { kind: 'closed'; code: number; reason: string };

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

  /** 开始连接（已经在连接或已连接时只更新 token）。 */
  start(token: string): void {
    this.token = token;
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    this.dial();
  }

  /** 主动退出：以 1000 关闭，不再重连（PRD F-AUTH-05）。 */
  stop(): void {
    this.active = false;
    this.clearReconnect();
    const conn = this.conn;
    this.teardown();
    conn?.close(1000, 'logout');
    this.setState('disconnected');
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
    this.setState('connecting');
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
        const ev = f.data as { type?: string; reason?: string } | undefined;
        if (ev?.type === 'kicked') {
          // 先记下原因，等随后的关闭码到达时统一处理。
          this.kickedReason = ev.reason ?? '';
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
      this.setState('connected');
      this.scheduleHeartbeat();
      this.emit('connected', f.data as AuthAck);
      return;
    }
    const p = f.id ? this.pending.get(f.id) : undefined;
    if (!p || !f.id) return;
    this.pending.delete(f.id);
    this.o.clock.clearTimeout(p.timer);
    const err = f.error ? new IMError(f.error.code, f.error.msg, f.error.userId ?? f.error.details?.userId) : undefined;
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
    const kicked = this.kickedReason;
    this.teardown();
    this.setState('disconnected');
    if (!this.active) return;

    // 被踢不重连（PRD F-AUTH-03 规则 4），例外：服务端下线按退避重连（C-55）。
    if (kicked !== null && kicked !== 'serverShutdown') {
      this.active = false;
      this.emit('fatal', { kind: 'kicked', reason: kicked, code });
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
    this.emit('state', s);
  }
}
