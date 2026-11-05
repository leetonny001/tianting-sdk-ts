/**
 * 当前会话的禁言状态（PRD-admin F-ADM-40、41、42）：mutedUntil 是服务端时间（毫秒），永久为 null。
 * scope 是 groupAll 时界面显示"群主已开启全员禁言"，mutedUntil 一定是 null。
 */
export interface MuteInfo {
  scope: 'user' | 'group' | 'groupAll';
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
  /** 开启了全群禁言的群；值为 true 表示服务端这个端发送时已经拒绝过（4031），不再按本地角色放行。 */
  private groupAll = new Map<string, boolean>();

  setUser(until: number | null | undefined): void {
    this.user = until;
  }

  setGroup(groupId: string, until: number | null | undefined): void {
    if (until === undefined) this.groups.delete(groupId);
    else this.groups.set(groupId, until);
  }

  setGroupAll(groupId: string, on: boolean, denied = false): void {
    if (on) this.groupAll.set(groupId, denied);
    else this.groupAll.delete(groupId);
  }

  /** 拿到了新的角色：之前那次拒绝可能是角色过期造成的，重新按角色判断。 */
  clearGroupAllDenied(groupId: string): void {
    if (this.groupAll.has(groupId)) this.groupAll.set(groupId, false);
  }

  /** 开启了全群禁言的群。 */
  groupAllIds(): string[] {
    return [...this.groupAll.keys()];
  }

  /**
   * 这个会话当前的禁言：用户级优先（F-ADM-41 规则 2），群内禁言只影响该群。
   * 全群禁言不限制群主、管理员（F-ADM-42），myRole 是服务端给的本端角色；发送已被 4031 拒绝时以服务端为准。
   */
  get(convId: string, now: number, myRole?: string): MuteInfo | null {
    if (this.user !== undefined && active(this.user, now)) return { scope: 'user', mutedUntil: this.user };
    if (!convId.startsWith('group:')) return null;
    const groupId = convId.slice('group:'.length);
    const until = this.groups.get(groupId);
    if (until !== undefined && active(until, now)) return { scope: 'group', groupId, mutedUntil: until };
    const denied = this.groupAll.get(groupId);
    if (denied === undefined) return null;
    const exempt = !denied && (myRole === 'owner' || myRole === 'admin');
    return exempt ? null : { scope: 'groupAll', groupId, mutedUntil: null };
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
    this.groupAll.clear();
  }

  /** 比较用的稳定表示：没有变化时不发事件。 */
  key(): string {
    // undefined（没有禁言）和 null（永久）不能序列化成同一个值。
    const sorted = <V>(m: Map<string, V>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));
    return JSON.stringify([this.user ?? String(this.user), sorted(this.groups), sorted(this.groupAll)]);
  }
}
