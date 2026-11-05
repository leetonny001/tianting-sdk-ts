// 社交关系（PRD-social 第 9、10 节，FE-100～FE-103）：协议类型、同步状态机、资料缓存。
// SocialState 是纯状态机（不做网络），与服务端的 Go 参考客户端（server/e2e/socialmodel）逐条对应，
// 跑同一份 protocol/vectors/social.json；网络与定时由 IMClient 驱动。

import type { GroupRole, TipBody } from './protocol.js';

// ---- 协议类型（frame.schema.json：Profile / FriendItem / RequestItem / BlockItem） ----

export interface Profile {
  nickname: string;
  avatar: string;
  official: boolean;
}

export type ApplySource = 'search' | 'group' | 'card' | 'conv' | 'other';

export interface FriendItem {
  userId: string;
  remark: string;
  source: ApplySource | 'admin';
  createdAt: number;
  ver: number;
  deleted?: boolean;
  profile: Profile | null;
}

export type RequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface RequestItem {
  userId: string;
  direction: 'in' | 'out';
  status: RequestStatus;
  message: string;
  source: ApplySource;
  applyCount: number;
  createdAt: number;
  updatedAt: number;
  expireAt: number;
  ver: number;
  /** direction=out 且对方还没同意时服务端不给资料（null）。 */
  profile: Profile | null;
}

export interface BlockItem {
  userId: string;
  createdAt: number;
  ver: number;
  deleted?: boolean;
  /** 对方不在我的可见范围内时为 null。 */
  profile: Profile | null;
}

export interface SocialItems {
  friends: FriendItem[];
  requests: RequestItem[];
  blocks: BlockItem[];
}

export interface SocialSyncAck {
  full: boolean;
  untilVer: number;
  latestVer: number;
  hasMore: boolean;
  cursor: string;
  restart?: boolean;
  friends: FriendItem[];
  requests: RequestItem[];
  blocks: BlockItem[];
  requestSeenVer: number;
  settings: { searchable: boolean };
  mode: 'open' | 'friends';
  strangerMsgLimit: number;
  official: boolean;
}

export interface SocialChangeAck {
  status?: 'pending' | 'accepted';
  ver: number;
  changed: boolean;
  items: SocialItems;
}

export type Relation = 'self' | 'blocked' | 'friend' | 'pendingIn' | 'pendingOut' | 'none';

/** userSearch 的结果。 */
export interface SearchedUser {
  userId: string;
  nickname: string;
  avatar: string;
  official: boolean;
  relation: Relation;
}

/** users 的一项、资料缓存的值。 */
export interface UserProfile {
  userId: string;
  nickname: string;
  avatar: string;
  official: boolean;
}

export interface MyGroup {
  groupId: string;
  name: string;
  memberCount: number;
  joinedAt: number;
}

export interface SocialSettings {
  searchable: boolean;
  mode: 'open' | 'friends';
  strangerMsgLimit: number;
}

// ---- 群（M4） ----

export interface GroupInfo {
  groupId: string;
  name: string;
  notice: string;
  noticeBy: string;
  noticeAt: number;
  /** 空字符串表示没有群主。 */
  owner: string;
  /** 托管群（业务方建的）。 */
  managed: boolean;
  myRole: GroupRole;
  memberCount: number;
  maxMembers: number;
  historyVisible: boolean;
  createdAt: number;
}

export interface GroupMemberInfo {
  userId: string;
  role: GroupRole;
  joinedAt: number;
  nickname: string;
  avatar: string;
  official: boolean;
}

/**
 * 提示消息的本地文案（PRD-ui F-UI-40，用例 protocol/vectors/social.json 的 tips）：
 * actor / targets 是自己时用"你"，其他人用 nameOf（可以是本机备注）。不认识的 kind 显示"[群通知]"。
 */
export function tipText(tip: TipBody, me: string, nameOf: (userId: string) => string): string {
  const who = (u: string) => (u === me ? '你' : nameOf(u));
  const shown = tip.targets.slice(0, 3).map(who).join('、');
  const total = Math.max(tip.count ?? 0, tip.targets.length);
  const targets = total > 3 ? `${shown} 等 ${total} 人` : shown;
  const actor = who(tip.actor);
  const you = tip.actor === me;
  switch (tip.kind) {
    case 'created':
      return `${spaced(actor, you)}创建了群聊`;
    case 'joined':
      return you ? `你邀请 ${targets} 加入了群聊` : `${actor} 邀请 ${targets} 加入了群聊`;
    case 'ownerChanged':
      if (tip.actor) return `${spaced(actor, you)}将群主转让给 ${targets}`;
      if (!tip.targets.length) return '群主已退出群聊';
      return targets === '你' ? '你已成为群主' : `${targets} 已成为群主`;
    case 'adminSet':
      return `${spaced(actor, you)}将 ${targets} 设为管理员`;
    case 'adminUnset':
      return `${spaced(actor, you)}取消了 ${targets} 的管理员`;
    case 'renamed':
      return `${spaced(actor, you)}修改群名为"${tip.text}"`;
    case 'noticeUpdated':
      return `${spaced(actor, you)}更新了群公告`;
  }
  return '[群通知]';
}

/**
 * 会话列表摘要的本地版本（与服务端 lastMsg.text 同一规则，PRD-social 5.5 节：只用昵称，不用"你"）。
 * 收到提示消息时先用它，下次 convs 时被服务端文本覆盖。
 */
export function tipSummary(tip: TipBody, nick: (userId: string) => string): string {
  const shown = tip.targets.slice(0, 3).map(nick).join('、');
  const total = Math.max(tip.count ?? 0, tip.targets.length);
  const list = total > 3 ? `${shown}等 ${total} 人` : shown;
  const actor = tip.actor ? nick(tip.actor) : '';
  switch (tip.kind) {
    case 'created':
    case 'joined':
      return `${actor} 邀请 ${list} 加入了群聊`;
    case 'ownerChanged':
      return tip.targets.length ? `${list} 已成为群主` : '群主已退出群聊';
    case 'adminSet':
      return `${list} 已成为管理员`;
    case 'adminUnset':
      return `${list} 不再是管理员`;
    case 'renamed':
      return `${actor} 修改群名为"${tip.text}"`;
    case 'noticeUpdated':
      return `${actor} 更新了群公告`;
  }
  return '[群通知]';
}

const spaced = (actor: string, you: boolean) => (you ? '你' : `${actor} `);

// ---- 界面看到的快照 ----

/** 好友（不含墓碑）。displayName 按 备注 → 昵称 → userId。 */
export interface Friend extends FriendItem {
  displayName: string;
  blocked: boolean;
}

/** "新的朋友"的一项：状态按服务端时间算出 expired；out 行没有服务端资料时用资料缓存。 */
export interface FriendRequest extends RequestItem {
  displayName: string;
}

export interface BlockedUser extends BlockItem {
  displayName: string;
}

/** 申请记录在本地保留的时长（F-SOC-04 规则 1）。 */
export const REQUEST_RETENTION_MS = 30 * 24 * 3600 * 1000;

type ReqKey = `${string}/${'in' | 'out'}`;
const reqKey = (r: { userId: string; direction: 'in' | 'out' }): ReqKey => `${r.userId}/${r.direction}`;

export type PageResult = 'continue' | 'restart' | 'done';

/**
 * 关系同步的本地状态（PRD-social 10.2 节）。sdk-ts 只在内存（D4）：每次刷新页面都是全量轮。
 */
export class SocialState {
  ver = 0;
  friends = new Map<string, FriendItem>(); // 含墓碑：按 ver 取较大者时要用
  requests = new Map<ReqKey, RequestItem>();
  blocks = new Map<string, BlockItem>();
  requestSeenVer = 0;
  settings: SocialSettings = { searchable: true, mode: 'open', strangerMsgLimit: 0 };
  official = false;
  /** 是否完成过至少一轮同步（通讯录骨架屏用）。 */
  loaded = false;
  /** 需要（再）开始一轮。 */
  needSync = false;

  private inRound = false;
  private full = false;
  private untilVer = 0;
  private staged: SocialState | null = null;
  private pendingEv = 0;

  /** 开始一轮，返回第一页的 sinceVer。 */
  beginRound(): number {
    this.inRound = true;
    this.staged = null;
    this.needSync = false;
    return this.ver;
  }

  get syncing(): boolean {
    return this.inRound;
  }

  /** 应用一页（F-SOC-06 规则 3、8）。 */
  applyPage(p: SocialSyncAck): PageResult {
    if (p.restart) {
      this.staged = null;
      return 'restart';
    }
    if (this.staged === null) {
      this.full = p.full;
      this.untilVer = p.untilVer;
      this.staged = p.full ? new SocialState() : this;
    }
    const t = this.staged;
    for (const f of p.friends) t.mergeFriend(f);
    for (const r of p.requests) t.mergeRequest(r);
    for (const b of p.blocks) t.mergeBlock(b);
    if (p.hasMore) return 'continue';
    if (this.full) {
      this.friends = t.friends;
      this.requests = t.requests;
      this.blocks = t.blocks;
    }
    this.ver = this.untilVer;
    this.requestSeenVer = p.requestSeenVer;
    this.settings = { searchable: p.settings.searchable, mode: p.mode, strangerMsgLimit: p.strangerMsgLimit };
    this.official = p.official;
    this.inRound = false;
    this.staged = null;
    this.loaded = true;
    this.needSync = p.latestVer > this.untilVer || this.pendingEv > this.untilVer;
    this.pendingEv = 0;
    return 'done';
  }

  /** 放弃进行中的一轮（请求失败）。 */
  abortRound(): void {
    this.inRound = false;
    this.staged = null;
  }

  /** socialChanged {ver}（F-SOC-06 规则 6；去抖由调用方负责）。 */
  onSocialChanged(ver: number): void {
    if (this.inRound) {
      this.pendingEv = Math.max(this.pendingEv, ver);
      return;
    }
    if (ver > this.ver) this.needSync = true;
  }

  /** 自己发起的修改的 ack（F-SOC-06 规则 7）。 */
  applyAck(ver: number, changed: boolean, items?: SocialItems): void {
    if (!changed) return;
    if (items) {
      for (const f of items.friends) this.mergeFriend(f);
      for (const r of items.requests) this.mergeRequest(r);
      for (const b of items.blocks) this.mergeBlock(b);
    }
    if (ver === this.ver + 1) this.ver = ver;
    else if (ver > this.ver + 1) this.needSync = true;
  }

  private mergeFriend(f: FriendItem): void {
    const old = this.friends.get(f.userId);
    if (!old || f.ver >= old.ver) this.friends.set(f.userId, f);
  }

  private mergeRequest(r: RequestItem): void {
    const k = reqKey(r);
    const old = this.requests.get(k);
    if (!old || r.ver >= old.ver) this.requests.set(k, r);
  }

  private mergeBlock(b: BlockItem): void {
    const old = this.blocks.get(b.userId);
    if (!old || b.ver >= old.ver) this.blocks.set(b.userId, b);
  }

  isFriend(userId: string): boolean {
    const f = this.friends.get(userId);
    return !!f && !f.deleted;
  }

  isBlocked(userId: string): boolean {
    const b = this.blocks.get(userId);
    return !!b && !b.deleted;
  }

  /** 申请的状态：未同意且过了 expireAt 就是 expired（按服务端时间）。 */
  static statusAt(r: RequestItem, serverNow: number): RequestStatus {
    return r.status !== 'accepted' && r.expireAt <= serverNow ? 'expired' : r.status;
  }

  /** 30 天内的申请，按 updatedAt 倒序（F-SOC-04 规则 1）。 */
  requestList(serverNow: number): RequestItem[] {
    const cutoff = serverNow - REQUEST_RETENTION_MS;
    return [...this.requests.values()]
      .filter((r) => r.updatedAt >= cutoff)
      .map((r) => {
        const status = SocialState.statusAt(r, serverNow);
        return status === r.status ? r : { ...r, status };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  /** 红点 = 收到的、pending、未过期、ver > requestSeenVer（F-SOC-04 规则 2）。 */
  unseen(serverNow: number): number {
    return this.requestList(serverNow).filter(
      (r) => r.direction === 'in' && r.status === 'pending' && r.ver > this.requestSeenVer,
    ).length;
  }

  /** 只看本地的关系（与 userSearch.relation 同一枚举、同一优先级）。 */
  relationOf(userId: string, self: string, serverNow: number): Relation {
    if (userId === self) return 'self';
    if (this.isBlocked(userId)) return 'blocked';
    if (this.isFriend(userId)) return 'friend';
    const pending = (dir: 'in' | 'out') => {
      const r = this.requests.get(`${userId}/${dir}`);
      return !!r && SocialState.statusAt(r, serverNow) === 'pending' && r.updatedAt >= serverNow - REQUEST_RETENTION_MS;
    };
    if (pending('in')) return 'pendingIn';
    if (pending('out')) return 'pendingOut';
    return 'none';
  }

  /** 被踢、退出登录时清空（F-AUTH-03）。 */
  clear(): void {
    Object.assign(this, new SocialState());
  }
}

/** 资料缓存（F-SOC-10 规则 6）：每个 userId 一条，10 分钟有效；任何带资料的服务端应答都直接覆盖。 */
export class ProfileCache {
  static readonly TTL_MS = 10 * 60 * 1000;
  private entries = new Map<string, { p: UserProfile; at: number }>();
  /** users 没有返回的人（不可见或不存在）：有效期内不重查，避免每次渲染都发请求、耗尽限流。 */
  private misses = new Map<string, number>();

  constructor(private readonly now: () => number) {}

  put(p: UserProfile): void {
    this.entries.set(p.userId, { p, at: this.now() });
    this.misses.delete(p.userId);
  }

  markMissing(userId: string): void {
    this.misses.set(userId, this.now());
  }

  /** 这个 userId 还需要向服务端查询吗（既没有有效资料，也不是最近查过没有的）。 */
  needsFetch(userId: string): boolean {
    if (this.fresh(userId)) return false;
    const at = this.misses.get(userId);
    return at === undefined || this.now() - at >= ProfileCache.TTL_MS;
  }

  putProfile(userId: string, p: Profile | null): void {
    if (p) this.put({ userId, nickname: p.nickname, avatar: p.avatar, official: p.official });
  }

  /** 有效期内的资料；过期返回 undefined（调用方重新查询）。 */
  fresh(userId: string): UserProfile | undefined {
    const e = this.entries.get(userId);
    return e && this.now() - e.at < ProfileCache.TTL_MS ? e.p : undefined;
  }

  /** 不论是否过期，最近一次拿到的资料（界面显示用，新的查询回来后再刷新）。 */
  last(userId: string): UserProfile | undefined {
    return this.entries.get(userId)?.p;
  }

  clear(): void {
    this.entries.clear();
    this.misses.clear();
  }
}
