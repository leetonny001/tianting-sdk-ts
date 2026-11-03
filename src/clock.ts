/** 时钟接口：SDK 里所有时间相关的逻辑都走它，测试时注入 FakeClock（FE-007）。 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export type TimerHandle = { readonly id: number } | ReturnType<typeof globalThis.setTimeout>;

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};
