// 系统推送的 pushes 流（PRD-live v1.0 4.3、4.5、4.8 节，规则 C1～C12）。三端一致的判据是 protocol/vectors/push-sync.json。
import type { Clock, TimerHandle } from './clock.js';
import { ErrorCode, IMError } from './errors.js';
import type { Logger } from './logger.js';

export type PushStart = 'beginning' | 'latest';

/** 交给业务的一条推送（4.8 节）。data 由业务解释，SDK 不写日志（F-PUSH-08 规则 3）。 */
export interface Push {
  pushId: string;
  type: string;
  data: unknown;
  ts: number;
  target: string;
  roomId?: string;
  pushSeq?: number;
  /** ts 早于本实例上该账号第一次 auth 的 serverTime（4.5 节规则 4）。 */
  replayed: boolean;
}

/** 都未校准（4.3、4.4 节），测试和灰度时可以覆盖。 */
export interface PushLimits {
  stashMax: number;
  noSeqQueueMax: number;
  seenMax: number;
  gapWaitMs: number;
  stashFlushMs: number;
  backoffMs: readonly number[];
}

export const PUSH_DEFAULTS: PushLimits = {
  stashMax: 200,
  noSeqQueueMax: 500,
  seenMax: 2000,
  gapWaitMs: 500,
  stashFlushMs: 5000,
  backoffMs: [1000, 2000, 4000, 8000, 16000, 30000],
};

/** SDK 固定用 100（4.2 节）。 */
const SYNC_LIMIT = 100;

export interface PushSyncAck {
  pushes: unknown[];
  hasMore: boolean;
  latestSeq: number;
}

type Frame = Omit<Push, 'replayed'>;
type InFlight = { afterSeq: number } | { fromLatest: true };

function parseFrame(raw: unknown): Frame | null {
  const f = raw as Partial<Frame> | null | undefined;
  if (!f || typeof f.pushId !== 'string' || typeof f.type !== 'string') return null;
  if (typeof f.ts !== 'number' || typeof f.target !== 'string') return null;
  if (f.pushSeq !== undefined && !(Number.isSafeInteger(f.pushSeq) && f.pushSeq > 0)) return null;
  const frame: Frame = { pushId: f.pushId, type: f.type, data: f.data, ts: f.ts, target: f.target };
  if (typeof f.roomId === 'string') frame.roomId = f.roomId;
  if (f.pushSeq !== undefined) frame.pushSeq = f.pushSeq;
  return frame;
}

export interface PushSyncDeps {
  clock: Clock;
  log: Logger;
  pushStart: PushStart;
  limits: PushLimits;
  request(data: Record<string, unknown>): Promise<PushSyncAck>;
  onSynced(latestSeq: number): void;
  onListenerError(err: unknown): void;
}

/**
 * 单游标补拉状态机。cursor 是已交付的最大连续序号；sdk-ts 没有持久化（4.9 节），它只在内存里，换账号清零。
 * 带 pushSeq 的帧都能从收件箱补回，所以没有订阅者时直接丢弃、暂存区满时可以清空；只有不带 pushSeq 的帧要排队（C4）。
 */
export class PushSync {
  private readonly subs = new Set<(p: Push) => void>();
  private pendingActivation = false; // 已注册、还没到调度点
  private activated = false; // 到过调度点且还有订阅者
  private gen = 0; // 回调内退订、退出登录时加一：正在进行的交付循环据此立刻停止

  private user: string | null = null;
  private t0 = 0;
  private cursorValue: number | null = null;
  private readonly seen = new Set<string>();
  private noSeqQueue: Frame[] = [];
  private readonly stash = new Map<number, Frame>();

  private connected = false;
  private disabled = false; // 这次连接收到过 4001（C9）
  private inflight: InFlight | null = null;
  private failed = false;
  private attempt = 0;
  private roundMax = 0; // 本轮已交付的最大 pushSeq（4.8 节）
  private gapTimer: TimerHandle | null = null;
  private flushTimer: TimerHandle | null = null;
  private backoffTimer: TimerHandle | null = null;

  constructor(private readonly d: PushSyncDeps) {}

  get cursor(): number | null {
    return this.cursorValue;
  }

  subscribe(fn: (p: Push) => void): () => void {
    this.subs.add(fn);
    if (!this.activated && !this.pendingActivation) {
      this.pendingActivation = true;
      queueMicrotask(() => this.activate());
    }
    return () => {
      if (this.subs.delete(fn) && this.subs.size === 0) this.stop();
    };
  }

  /** auth 成功（含重连）。换账号时调用方已经先调过 logout；这里再按 userId 兜一次，不把 u1 的状态留给 u2。 */
  onAuth(userId: string, serverTime: number): void {
    if (this.user !== userId) {
      this.logout();
      this.user = userId;
      this.t0 = serverTime;
      this.cursorValue = this.d.pushStart === 'latest' ? null : 0;
    }
    this.connected = true;
    this.disabled = false;
    if (this.pendingActivation) this.activate();
    else if (this.activated) this.startRound();
  }

  /** 连接断开：进行中的请求算失败，定时器和退避清零，暂存保留到重连后合并（C9）。 */
  onDisconnected(): void {
    this.connected = false;
    this.inflight = null;
    this.failed = false;
    this.attempt = 0;
    this.cancelTimers();
  }

  logout(): void {
    this.onDisconnected();
    this.gen++;
    this.user = null;
    this.t0 = 0;
    this.cursorValue = null;
    this.seen.clear();
    this.noSeqQueue = [];
    this.stash.clear();
    this.roundMax = 0;
    this.disabled = false;
  }

  onLive(raw: unknown): void {
    if (this.pendingActivation) this.activate(); // 调度点先于任何网络事件（4.8 节）
    const f = parseFrame(raw);
    if (!f) {
      this.d.log.warn('im: invalid push frame');
      return;
    }
    if (this.user === null) return;
    if (f.pushSeq === undefined) {
      if (this.activated) {
        this.deliver(f);
      } else {
        this.noSeqQueue.push(f);
        if (this.noSeqQueue.length > this.d.limits.noSeqQueueMax) this.noSeqQueue.shift();
      }
      return;
    }
    if (!this.activated) return; // C12
    const cursor = this.cursorValue;
    if (cursor === null) {
      this.addToStash(f); // C10：fromLatest 应答前
    } else if (f.pushSeq <= cursor) {
      this.deliver(f); // C3
    } else if (f.pushSeq === cursor + 1) {
      if (!this.deliver(f)) return;
      this.cursorValue = f.pushSeq; // C1
      this.drainStash(true);
    } else {
      this.addToStash(f); // C2
      this.armGapTimer();
    }
  }

  private activate(): void {
    this.pendingActivation = false;
    if (this.subs.size === 0 || this.activated) return;
    this.activated = true;
    while (this.noSeqQueue.length > 0) {
      if (!this.deliver(this.noSeqQueue.shift()!)) return;
    }
    if (this.connected && !this.inflight) this.startRound();
  }

  /** 订阅者全部退出（C12）。进行中的请求不取消：迟到的 ack 丢弃，又有订阅者时按正常处理（不发第二个）。 */
  private stop(): void {
    this.gen++;
    this.activated = false;
    this.stash.clear();
    this.failed = false;
    this.attempt = 0;
    this.roundMax = 0;
    this.cancelTimers();
  }

  /** 交付一条（已见过的跳过，算成功）。返回 false 表示回调里停掉了，调用方不能再动游标、不能继续。 */
  private deliver(f: Frame): boolean {
    if (this.seen.has(f.pushId)) return true;
    this.seen.add(f.pushId);
    if (this.seen.size > this.d.limits.seenMax) this.seen.delete(this.seen.values().next().value!);
    if (f.pushSeq !== undefined && f.pushSeq > this.roundMax) this.roundMax = f.pushSeq;
    const gen = this.gen;
    const item: Push = { ...f, replayed: f.ts < this.t0 };
    for (const fn of [...this.subs]) {
      if (!this.subs.has(fn)) continue; // 同一轮里被前面的回调退订了
      try {
        fn(item);
      } catch (err) {
        this.d.onListenerError(err); // F-PUSH-08 规则 2：业务抛异常不影响 SDK
      }
    }
    return gen === this.gen;
  }

  private addToStash(f: Frame): void {
    const seq = f.pushSeq!;
    if (!this.stash.has(seq) && this.stash.size >= this.d.limits.stashMax) this.stash.clear(); // 清掉的都能补回
    this.stash.set(seq, f);
    if (this.failed) this.armFlushTimer();
  }

  /** C11：按序取出能接上的暂存帧。 */
  private drainStash(allowTimer: boolean): boolean {
    for (const seq of this.stashSeqs()) {
      const cursor = this.cursorValue;
      if (cursor === null || seq > cursor + 1) break;
      const f = this.stash.get(seq)!;
      this.stash.delete(seq);
      if (!this.deliver(f)) return false;
      if (seq === cursor + 1) this.cursorValue = seq;
    }
    if (this.stash.size === 0) {
      this.cancelGapTimer();
      this.cancelFlushTimer();
    } else if (allowTimer) {
      this.armGapTimer();
    }
    return true;
  }

  private stashSeqs(): number[] {
    return [...this.stash.keys()].sort((a, b) => a - b);
  }

  private armGapTimer(): void {
    if (this.gapTimer !== null || this.stash.size === 0) return;
    if (!this.connected || this.disabled || this.inflight || this.backoffTimer !== null) return;
    this.gapTimer = this.d.clock.setTimeout(() => {
      this.gapTimer = null;
      this.startRound();
    }, this.d.limits.gapWaitMs);
  }

  private armFlushTimer(): void {
    if (this.flushTimer !== null || this.stash.size === 0) return;
    this.flushTimer = this.d.clock.setTimeout(() => {
      this.flushTimer = null;
      const frames = this.stashSeqs().map((s) => this.stash.get(s)!);
      this.stash.clear();
      for (const f of frames) if (!this.deliver(f)) return; // 游标不前进，之后的补拉靠 pushId 去重
    }, this.d.limits.stashFlushMs);
  }

  private cancelGapTimer(): void {
    if (this.gapTimer !== null) this.d.clock.clearTimeout(this.gapTimer);
    this.gapTimer = null;
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) this.d.clock.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private cancelTimers(): void {
    this.cancelGapTimer();
    this.cancelFlushTimer();
    if (this.backoffTimer !== null) this.d.clock.clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
  }

  /** 一轮补拉的开始：翻页和退避重试不算新一轮（4.8 节）。 */
  private startRound(): void {
    if (!this.connected || this.disabled || this.inflight) return;
    this.roundMax = 0;
    this.send();
  }

  private send(): void {
    const cursor = this.cursorValue;
    const req: InFlight = cursor === null ? { fromLatest: true } : { afterSeq: cursor };
    this.inflight = req;
    this.cancelGapTimer();
    const data = cursor === null ? { fromLatest: true } : { afterSeq: cursor, limit: SYNC_LIMIT };
    this.d.request(data).then(
      (ack) => {
        if (this.inflight === req) this.onAck(req, ack);
      },
      (err: unknown) => {
        if (this.inflight === req) this.onFail(err);
      },
    );
  }

  private onFail(err: unknown): void {
    this.inflight = null;
    if (err instanceof IMError && err.code === ErrorCode.UNKNOWN_CMD) {
      this.disabled = true; // 服务端未开启：静默，这次连接内不再发（C9）
      this.cancelGapTimer();
      return;
    }
    this.d.log.warn(`im: pushSync failed: ${err instanceof IMError ? err.code : String(err)}`);
    if (!this.activated) return;
    this.failed = true;
    const { backoffMs } = this.d.limits;
    const delay = backoffMs[Math.min(this.attempt, backoffMs.length - 1)]!;
    this.attempt++;
    this.backoffTimer = this.d.clock.setTimeout(() => {
      this.backoffTimer = null;
      this.send();
    }, delay);
    this.armFlushTimer();
  }

  private onAck(req: InFlight, ack: PushSyncAck): void {
    this.inflight = null;
    if (!this.activated) return; // C12：迟到的 ack 丢弃，不交付、不动游标
    const valid = Array.isArray(ack?.pushes) && typeof ack.hasMore === 'boolean' && typeof ack.latestSeq === 'number';
    if (!valid) {
      this.onFail(new Error('malformed pushSync ack'));
      return;
    }
    if ('fromLatest' in req) {
      this.succeeded();
      this.cursorValue = ack.latestSeq; // C10：忽略 pushes 和 hasMore
      if (this.drainStash(true)) this.finishRound(ack.latestSeq);
      return;
    }
    const page: Frame[] = [];
    let pageMax = 0;
    for (const raw of ack.pushes) {
      const f = parseFrame(raw);
      if (f?.pushSeq === undefined) {
        this.d.log.warn('im: invalid push in pushSync ack');
        continue;
      }
      page.push(f);
      if (f.pushSeq > pageMax) pageMax = f.pushSeq;
    }
    if (ack.hasMore) {
      if (pageMax <= req.afterSeq) {
        this.onFail(new Error('pushSync hasMore without progress')); // C6：违反服务端保证，避免原地死循环
        return;
      }
      this.succeeded();
      if (!this.deliverPage(page, pageMax)) return;
      this.cursorValue = Math.max(this.cursorValue!, pageMax);
      if (this.drainStash(false)) this.send(); // C6：先接上暂存帧，再取下一页
      return;
    }
    this.succeeded();
    if (ack.latestSeq < req.afterSeq) {
      // C8：服务端从备份恢复。不走 C11，本轮重新开始，靠 pushId 去重。
      this.cursorValue = 0;
      this.stash.clear();
      this.cancelTimers();
      this.roundMax = 0;
      this.send();
      return;
    }
    if (!this.deliverPage(page, ack.latestSeq)) return;
    this.cursorValue = Math.max(this.cursorValue!, ack.latestSeq); // C7：结果为空也前进，尾部过期不会让游标停住
    if (this.drainStash(true)) this.finishRound(ack.latestSeq);
  }

  private succeeded(): void {
    this.failed = false;
    this.attempt = 0;
    this.cancelFlushTimer();
  }

  /** C6、C7：本页和暂存区里不大于 limit 的帧合并，按序交付，见过的跳过。 */
  private deliverPage(page: Frame[], limit: number): boolean {
    const merged = [...page];
    for (const seq of this.stashSeqs()) {
      if (seq > limit) break;
      merged.push(this.stash.get(seq)!);
      this.stash.delete(seq);
    }
    merged.sort((a, b) => a.pushSeq! - b.pushSeq!);
    for (const f of merged) if (!this.deliver(f)) return false;
    return true;
  }

  private finishRound(latestSeq: number): void {
    this.d.onSynced(Math.max(latestSeq, this.roundMax));
  }
}
