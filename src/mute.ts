/** 当前会话的禁言状态（PRD-admin F-ADM-40、41）：mutedUntil 是服务端时间（毫秒），永久为 null。 */
export interface MuteInfo {
  scope: 'user' | 'group';
  groupId?: string;
  mutedUntil: number | null;
}

const active = (until: number | null, now: number) => until === null || until > now;

/**
 * 禁言表：一条用户级记录、每个群一条群内记录。不存在用 undefined 表示（null 是永久禁言）。
 * 所有 now 都是服务端时间，由 IMClient 传入。
 */
export class MuteTable {
  private user: number | null | undefined;
  private groups = new Map<string, number | null>();

  setUser(until: number | null | undefined): void {
    this.user = until;
  }

  setGroup(groupId: string, until: number | null | undefined): void {
    if (until === undefined) this.groups.delete(groupId);
    else this.groups.set(groupId, until);
  }

  /** 这个会话当前的禁言：用户级优先（F-ADM-41 规则 2），群内禁言只影响该群。 */
  get(convId: string, now: number): MuteInfo | null {
    if (this.user !== undefined && active(this.user, now)) return { scope: 'user', mutedUntil: this.user };
    if (!convId.startsWith('group:')) return null;
    const groupId = convId.slice('group:'.length);
    const until = this.groups.get(groupId);
    return until !== undefined && active(until, now) ? { scope: 'group', groupId, mutedUntil: until } : null;
  }

  /** 最早的到期时间；没有会到期的记录时为 null。 */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const until of [this.user, ...this.groups.values()]) {
      if (typeof until === 'number' && (next === null || until < next)) next = until;
    }
    return next;
  }

  /** 去掉已经到期的记录。 */
  purge(now: number): void {
    if (this.user !== undefined && !active(this.user, now)) this.user = undefined;
    for (const [g, until] of this.groups) if (!active(until, now)) this.groups.delete(g);
  }

  clear(): void {
    this.user = undefined;
    this.groups.clear();
  }

  /** 比较用的稳定表示：没有变化时不发事件。 */
  key(): string {
    // undefined（没有禁言）和 null（永久）不能序列化成同一个值。
    return JSON.stringify([this.user ?? String(this.user), [...this.groups].sort(([a], [b]) => (a < b ? -1 : 1))]);
  }
}
