type Listener = (...args: unknown[]) => void;

/** 最小的类型安全事件分发器。监听器抛出的异常不会影响其他监听器和 SDK 内部状态。 */
export class Emitter<Events extends Record<string, unknown[]>> {
  private listeners = new Map<keyof Events, Set<Listener>>();

  on<K extends keyof Events>(event: K, fn: (...args: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const l = fn as unknown as Listener;
    set.add(l);
    return () => set.delete(l);
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }

  /** 监听器出错时调用（由使用方设置，例如转给 logger）。 */
  onListenerError: (err: unknown) => void = () => {};
}
