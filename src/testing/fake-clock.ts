import type { Clock, TimerHandle } from '../clock.js';

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** 可控时钟（FE-007）：advance(ms) 时按到期顺序执行定时器，心跳、超时、退避、节流都能确定性地测试。 */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private timers: Timer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer = { id: this.nextId++, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return { id: timer.id };
  }

  clearTimeout(handle: TimerHandle): void {
    const id = (handle as { id: number }).id;
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  /** 时间前进 ms，期间到期的定时器按时间顺序执行（定时器里新建的、在窗口内到期的也会执行）。 */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }

  /** 待执行的定时器数量。 */
  get pending(): number {
    return this.timers.length;
  }
}
