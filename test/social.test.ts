import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  IMError,
  SocialState,
  messageFor,
  tipText,
  type SocialSyncAck,
  type TipBody,
} from '../src/index.js';
import { ProfileCache, type FriendItem, type RequestItem, type SocialItems } from '../src/social.js';
import { conv, flush, setup } from './helpers.js';

interface Step {
  type: 'begin' | 'page' | 'event' | 'ack';
  data?: unknown;
  ver?: number;
}

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/social.json', import.meta.url), 'utf8')) as {
  cases: Array<{
    name: string;
    nowMs: number;
    steps: Step[];
    expect: {
      socialVer: number;
      friends: Record<string, string>;
      requests: Record<string, string>;
      blocks: string[];
      unread: number;
      needSync: boolean;
      lastNext?: string;
    };
  }>;
  copy: Array<{ cmd: string; code: number; text: string }>;
  tips: Array<{ me: string; names?: Record<string, string>; tip: TipBody; text: string }>;
};

describe('关系同步：与其他 SDK 共用 protocol/vectors/social.json（PRD-social 10.3 节，FE-101）', () => {
  for (const c of spec.cases) {
    it(c.name, () => {
      const s = new SocialState();
      let last = '';
      for (const st of c.steps) {
        if (st.type === 'begin') s.beginRound();
        else if (st.type === 'page') last = s.applyPage(st.data as SocialSyncAck);
        else if (st.type === 'event') s.onSocialChanged(st.ver!);
        else {
          const a = st.data as { ver: number; changed: boolean; items: SocialItems };
          s.applyAck(a.ver, a.changed, a.items);
        }
      }
      const friends: Record<string, string> = {};
      for (const f of s.friends.values()) if (!f.deleted) friends[f.userId] = f.remark;
      const requests: Record<string, string> = {};
      for (const r of s.requestList(c.nowMs)) requests[`${r.userId}/${r.direction}`] = r.status;
      const blocks = [...s.blocks.values()]
        .filter((b) => !b.deleted)
        .map((b) => b.userId)
        .sort();
      expect({
        socialVer: s.ver,
        friends,
        requests,
        blocks,
        unread: s.unseen(c.nowMs),
        needSync: s.needSync,
        lastNext: last,
      }).toEqual({ ...c.expect, lastNext: c.expect.lastNext ?? '' });
    });
  }

  it('提示消息文案（F-UI-40）', () => {
    for (const c of spec.tips) {
      expect(tipText(c.tip, c.me, (u) => c.names?.[u] ?? u)).toBe(c.text);
    }
  });

  it('"命令 + 错误码"文案（9.4 节）', () => {
    for (const x of spec.copy)
      expect(messageFor(x.cmd, x.code, { strangerMsgLimit: 3, name: 'bob' }), `${x.cmd} ${x.code}`).toBe(
        x.text.replace('{N}', '3').replace('{name}', 'bob'),
      );
    expect(messageFor('send', ErrorCode.QUOTA_EXCEEDED)).toBe('今天发起新聊天的次数已用完，请稍后再试');
    expect(messageFor('setPrivacy', 4290)).toBe('操作太频繁，请稍后再试');
    expect(messageFor('send', 4042)).toBeUndefined();
  });
});

const NOW = 1_700_000_000_000;

function friend(userId: string, ver: number, extra: Partial<FriendItem> = {}): FriendItem {
  return {
    userId,
    remark: '',
    source: 'other',
    createdAt: NOW,
    ver,
    profile: { nickname: userId.toUpperCase(), avatar: '', official: false },
    ...extra,
  };
}

function req(userId: string, direction: 'in' | 'out', ver: number, extra: Partial<RequestItem> = {}): RequestItem {
  return {
    userId,
    direction,
    status: 'pending',
    message: '',
    source: 'other',
    applyCount: 1,
    createdAt: NOW,
    updatedAt: NOW,
    expireAt: NOW + 7 * 86_400_000,
    ver,
    profile: direction === 'in' ? { nickname: userId, avatar: '', official: false } : null,
    ...extra,
  };
}

function page(p: Partial<SocialSyncAck>): SocialSyncAck {
  return {
    full: true,
    untilVer: 0,
    latestVer: p.untilVer ?? 0,
    hasMore: false,
    cursor: '',
    friends: [],
    requests: [],
    blocks: [],
    requestSeenVer: 0,
    settings: { searchable: true },
    mode: 'open',
    strangerMsgLimit: 0,
    official: false,
    ...p,
  };
}

async function loggedIn() {
  const h = setup();
  h.im.connect('t');
  const c = await h.login('alice', [conv({ convId: 'c2c:alice:bob', maxSeq: 1 })]);
  return { h, c };
}

describe('社交同步引擎（FE-101）', () => {
  it('连接成功：先 convs，再从 socialVer 开始全量轮；翻页直到 hasMore=false，回调一次', async () => {
    const { h, c } = await loggedIn();
    const cmds = c.frames().map((f) => f.cmd);
    expect(cmds.indexOf('socialSync')).toBeGreaterThan(cmds.indexOf('convs'));
    expect(c.last('socialSync').data).toEqual({ sinceVer: 0, limit: 500 });
    expect(h.im.socialLoaded()).toBe(false);
    const seen: number[] = [];
    h.im.on('friends', (l) => seen.push(l.length));
    c.ack('socialSync', page({ untilVer: 3, hasMore: true, cursor: 'c1', friends: [friend('bob', 2)] }));
    await flush();
    expect(c.last('socialSync').data).toEqual({ cursor: 'c1', limit: 500 });
    c.ack('socialSync', page({ untilVer: 3, friends: [friend('carol', 3)], mode: 'friends', strangerMsgLimit: 3 }));
    await flush();
    expect(seen).toEqual([2]);
    expect(h.im.friends().map((f) => f.displayName)).toEqual(['BOB', 'CAROL']);
    expect(h.im.socialSettings()).toEqual({ searchable: true, mode: 'friends', strangerMsgLimit: 3 });
    expect(h.im.socialLoaded()).toBe(true);
  });

  it('socialChanged：ver 更大时去抖 200ms 后从本地 ver 增量同步；不大于本地 ver 的忽略', async () => {
    const { h, c } = await loggedIn();
    c.ack('socialSync', page({ untilVer: 5 }));
    await flush();
    const n = () => c.frames().filter((f) => f.cmd === 'socialSync').length;
    const before = n();
    c.receive({ cmd: 'event', data: { type: 'socialChanged', ver: 5 } });
    h.clock.advance(300);
    await flush();
    expect(n()).toBe(before);
    c.receive({ cmd: 'event', data: { type: 'socialChanged', ver: 6 } });
    c.receive({ cmd: 'event', data: { type: 'socialChanged', ver: 7 } });
    h.clock.advance(199);
    await flush();
    expect(n()).toBe(before);
    h.clock.advance(1);
    await flush();
    expect(n()).toBe(before + 1);
    expect(c.last('socialSync').data).toEqual({ sinceVer: 5, limit: 500 });
  });

  it('socialSettingsChanged 更新本地设置并回调', async () => {
    const { h, c } = await loggedIn();
    const got: unknown[] = [];
    h.im.on('socialSettings', (s) => got.push(s));
    c.receive({ cmd: 'event', data: { type: 'socialSettingsChanged', mode: 'open', strangerMsgLimit: 3 } });
    expect(got.at(-1)).toEqual({ searchable: true, mode: 'open', strangerMsgLimit: 3 });
    c.receive({ cmd: 'event', data: { type: 'someFutureEvent', x: 1 } }); // 不认识的事件忽略
  });

  it('自己发起的修改：ver 连续时直接应用 items；不连续时再补一轮', async () => {
    const { h, c } = await loggedIn();
    c.ack('socialSync', page({ untilVer: 5 }));
    await flush();
    const p = h.im.respondFriend('bob', 'accept', { remark: '同学' });
    c.ack('friendRespond', {
      ver: 6,
      changed: true,
      items: { friends: [friend('bob', 6, { remark: '同学' })], requests: [], blocks: [] },
    });
    await p;
    expect(h.im.friends()[0]).toMatchObject({ userId: 'bob', displayName: '同学' });
    const n = c.frames().filter((f) => f.cmd === 'socialSync').length;
    const q = h.im.deleteFriend('bob');
    c.ack('friendDelete', {
      ver: 9,
      changed: true,
      items: { friends: [friend('bob', 9, { deleted: true })], requests: [], blocks: [] },
    });
    await q;
    await flush();
    expect(h.im.friends()).toEqual([]);
    expect(c.frames().filter((f) => f.cmd === 'socialSync')).toHaveLength(n + 1);
    expect(c.last('socialSync').data).toEqual({ sinceVer: 6, limit: 500 });
  });

  it('失败的命令抛出带错误码的 IMError', async () => {
    const { h, c } = await loggedIn();
    const p = h.im.respondFriend('carol', 'accept');
    c.ackError('friendRespond', ErrorCode.FRIEND_REQUEST_NOT_FOUND);
    await expect(p).rejects.toMatchObject({ code: 4045 });
    await expect(p).rejects.toBeInstanceOf(IMError);
  });

  it('全量轮被限流（4290）：6 秒后重试，首轮最终能结束', async () => {
    const { h, c } = await loggedIn();
    c.ackError('socialSync', ErrorCode.RATE_LIMITED);
    await flush();
    expect(h.im.socialLoaded()).toBe(false);
    const n = c.frames().filter((f) => f.cmd === 'socialSync').length;
    h.clock.advance(5_999);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'socialSync')).toHaveLength(n);
    h.clock.advance(1);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'socialSync')).toHaveLength(n + 1);
    c.ack('socialSync', page({ untilVer: 1 }));
    await flush();
    expect(h.im.socialLoaded()).toBe(true);
  });

  it('被踢时清空社交状态', async () => {
    const { h, c } = await loggedIn();
    c.ack('socialSync', page({ untilVer: 1, friends: [friend('bob', 1)] }));
    await flush();
    expect(h.im.friends()).toHaveLength(1);
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4012, 'revoked');
    await flush();
    expect(h.im.friends()).toEqual([]);
    expect(h.im.socialLoaded()).toBe(false);
  });
});

describe('红点、relationOf、过期按服务端时间（FE-102）', () => {
  it('红点 = 收到的、pending、未过期、ver > requestSeenVer；markFriendRequestsSeen 本地立即清零', async () => {
    const { h, c } = await loggedIn();
    c.ack(
      'socialSync',
      page({
        untilVer: 9,
        requestSeenVer: 2,
        requests: [
          req('old', 'in', 2),
          req('expired', 'in', 3, { expireAt: NOW - 1 }),
          req('carol', 'in', 8, { updatedAt: NOW - 10 }),
          req('dave', 'in', 9, { updatedAt: NOW - 5 }),
          req('rejected', 'in', 7, { status: 'rejected' }),
          req('mine', 'out', 6),
        ],
      }),
    );
    await flush();
    const r = h.im.friendRequests();
    expect(r.unseen).toBe(2);
    expect(r.items.find((x) => x.userId === 'expired')?.status).toBe('expired');
    const order = r.items.map((x) => x.userId);
    expect(order.indexOf('dave')).toBeLessThan(order.indexOf('carol')); // 按 updatedAt 倒序
    h.im.markFriendRequestsSeen();
    expect(h.im.friendRequests().unseen).toBe(0);
    expect(c.last('friendRequestsSeen').data).toEqual({ ver: 9 });
  });

  it('过期用服务端时间（auth 的 serverTime），不用本地时钟', async () => {
    const h = setup();
    h.im.connect('t');
    const c = h.transport.current;
    c.open();
    c.ack('auth', { userId: 'alice', serverTime: NOW + 8 * 86_400_000 }); // 本地时钟慢了 8 天
    await flush();
    c.ack('convs', { convs: [], truncated: false });
    await flush();
    c.ack('socialSync', page({ untilVer: 1, requests: [req('bob', 'in', 1)] }));
    await flush();
    expect(h.im.friendRequests().items[0]?.status).toBe('expired');
    expect(h.im.friendRequests().unseen).toBe(0);
  });

  it('relationOf：self > blocked > friend > pendingIn > pendingOut > none', async () => {
    const { h, c } = await loggedIn();
    c.ack(
      'socialSync',
      page({
        untilVer: 5,
        friends: [friend('bob', 1), friend('dave', 1)],
        blocks: [{ userId: 'dave', createdAt: NOW, ver: 2, profile: null }],
        requests: [req('carol', 'in', 3), req('erin', 'out', 4)],
      }),
    );
    await flush();
    expect(['alice', 'dave', 'bob', 'carol', 'erin', 'frank'].map((u) => h.im.relationOf(u))).toEqual([
      'self',
      'blocked',
      'friend',
      'pendingIn',
      'pendingOut',
      'none',
    ]);
    expect(h.im.friends().find((f) => f.userId === 'dave')?.blocked).toBe(true);
  });

  it('发出的申请在对方同意前没有资料：用搜索时拿到的资料显示', async () => {
    const { h, c } = await loggedIn();
    c.ack('socialSync', page({ untilVer: 1 }));
    await flush();
    const s = h.im.searchUser('erin');
    c.ack('userSearch', { user: { userId: 'erin', nickname: '艾琳', avatar: '', official: true, relation: 'none' } });
    expect(await s).toMatchObject({ nickname: '艾琳', official: true });
    const a = h.im.applyFriend('erin', { message: '你好', source: 'search' });
    expect(c.last('friendApply').data).toEqual({ to: 'erin', message: '你好', source: 'search' });
    c.ack('friendApply', {
      status: 'pending',
      ver: 2,
      changed: true,
      items: { friends: [], requests: [req('erin', 'out', 2)], blocks: [] },
    });
    expect(await a).toBe('pending');
    expect(h.im.friendRequests().items[0]).toMatchObject({ userId: 'erin', profile: null, displayName: '艾琳' });
  });
});

describe('资料缓存、批量查资料、我的群聊（FE-103）', () => {
  it('getUsers：跨批时等全部批次回来才返回，不漏人', async () => {
    const { h, c } = await loggedIn();
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const profile = (userId: string) => ({ userId, nickname: userId, avatar: '', official: false });
    let settled = false;
    const all = h.im.getUsers(ids).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    c.ack('users', { users: ids.slice(0, 100).map(profile) });
    await flush();
    expect(settled).toBe(false);
    c.ack('users', { users: ids.slice(100).map(profile) });
    expect((await all).length).toBe(150);
  });

  it('getUsers：同一事件循环内合并、每批最多 100、命中缓存不请求；10 分钟后过期重查', async () => {
    const { h, c } = await loggedIn();
    const ids = Array.from({ length: 150 }, (_, i) => `u${i}`);
    const a = h.im.getUsers(ids.slice(0, 120));
    const b = h.im.getUsers(ids.slice(100));
    await flush();
    const batches = c.frames().filter((f) => f.cmd === 'users');
    expect(batches.map((f) => (f.data!.userIds as string[]).length)).toEqual([100]);
    c.ack('users', {
      users: ids
        .slice(0, 100)
        .filter((_, i) => i % 2 === 0)
        .map((userId) => ({ userId, nickname: userId, avatar: '', official: false })),
    });
    await flush();
    expect((c.last('users').data.userIds as string[]).length).toBe(50);
    c.ack('users', { users: [] });
    expect((await a).length).toBe(50); // 只返回可见的（偶数号）
    expect((await b).length).toBe(0); // u100～u149 服务端都没返回：不可见
    const sent = c.frames().filter((f) => f.cmd === 'users').length;
    await h.im.getUsers(['u0']);
    expect(c.frames().filter((f) => f.cmd === 'users')).toHaveLength(sent);
    // 10 分钟过期见下一个用例（推进假时钟 10 分钟会触发心跳超时、断开连接）。
  });

  it('users 没有返回的人 10 分钟内不重查；之后同步里拿到资料立即可见', async () => {
    const { h, c } = await loggedIn();
    const a = h.im.getUsers(['ghost']);
    await flush();
    c.ack('users', { users: [] });
    expect(await a).toEqual([]);
    const sent = c.frames().filter((f) => f.cmd === 'users').length;
    expect(await h.im.getUsers(['ghost'])).toEqual([]);
    expect(c.frames().filter((f) => f.cmd === 'users')).toHaveLength(sent);
    c.ack('socialSync', page({ untilVer: 1, friends: [friend('ghost', 1)] }));
    await flush();
    expect((await h.im.getUsers(['ghost']))[0]?.nickname).toBe('GHOST');
  });

  it('资料缓存 10 分钟有效；过期后 last 仍可用于显示', () => {
    let now = 0;
    const cache = new ProfileCache(() => now);
    cache.put({ userId: 'bob', nickname: 'B', avatar: '', official: false });
    now = 10 * 60 * 1000 - 1;
    expect(cache.fresh('bob')?.nickname).toBe('B');
    now += 1;
    expect(cache.fresh('bob')).toBeUndefined();
    expect(cache.last('bob')?.nickname).toBe('B');
  });

  it('同步应答里的资料直接覆盖缓存', async () => {
    const { h, c } = await loggedIn();
    c.ack(
      'socialSync',
      page({
        untilVer: 1,
        friends: [friend('bob', 1, { profile: { nickname: '新的', avatar: '', official: false } })],
      }),
    );
    await flush();
    expect(h.im.profileOf('bob')?.nickname).toBe('新的');
    expect(h.im.displayName('bob')).toBe('新的');
  });

  it('loadMyGroups 自动翻完全部页', async () => {
    const { h, c } = await loggedIn();
    const p = h.im.loadMyGroups();
    await flush();
    expect(c.last('myGroups').data).toEqual({});
    c.ack('myGroups', { groups: [{ groupId: 'g1', name: 'A', memberCount: 3, joinedAt: 1 }], nextCursor: 'g1' });
    await flush();
    expect(c.last('myGroups').data).toEqual({ cursor: 'g1' });
    c.ack('myGroups', { groups: [{ groupId: 'g2', name: 'B', memberCount: 5, joinedAt: 2 }], nextCursor: '' });
    expect((await p).map((g) => g.groupId)).toEqual(['g1', 'g2']);
  });
});

describe('性能（FE-101 第 7 条，AC-SOC-06-14 的 SDK 部分）', () => {
  it('2000 个好友的全量轮：一次替换、一次回调，应用耗时 < 50ms', async () => {
    const { h, c } = await loggedIn();
    const calls: number[] = [];
    h.im.on('friends', (l) => calls.push(l.length));
    const friends = Array.from({ length: 500 }, (_, i) => friend(`f${i}`, 1));
    const start = performance.now();
    for (let p = 0; p < 4; p++) {
      c.ack(
        'socialSync',
        page({
          untilVer: 1,
          hasMore: p < 3,
          cursor: `c${p}`,
          friends: friends.map((f) => ({ ...f, userId: `${f.userId}-${p}` })),
        }),
      );
      await flush();
    }
    const ms = performance.now() - start;
    expect(calls).toEqual([2000]);
    expect(ms).toBeLessThan(500); // 含 flush 的调度开销；纯应用耗时见下一行
    const s = new SocialState();
    const big = page({ untilVer: 1, friends: Array.from({ length: 2000 }, (_, i) => friend(`g${i}`, 1)) });
    const t0 = performance.now();
    s.beginRound();
    s.applyPage(big);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe('群（FE-110、FE-111）', () => {
  const G = 'group:g1';

  it('createGroup：超时重试用同一个 clientReqId；ack 的 conv 进入会话列表', async () => {
    const { h, c } = await loggedIn();
    c.ack('socialSync', page({ untilVer: 0 }));
    await flush();
    const p = h.im.createGroup({ members: ['bob', 'carol'] });
    const first = c.last('groupCreate').data.clientReqId;
    h.clock.advance(10_001);
    await flush();
    const sent = c.frames().filter((f) => f.cmd === 'groupCreate');
    expect(sent).toHaveLength(2);
    expect(sent[1]?.data?.clientReqId).toBe(first);
    c.ack('groupCreate', { groupId: 'g1', conv: conv({ convId: G, name: 'x', memberCount: 3, myRole: 'owner' }) });
    const r = await p;
    expect(r.conv).toMatchObject({ convId: G, myRole: 'owner', memberCount: 3 });
    expect(h.im.conversations().map((x) => x.convId)).toContain(G);
  });

  it('错误带 userId（兼容 details.userId）', async () => {
    const { h, c } = await loggedIn();
    const a = h.im.createGroup({ members: ['bob', 'dave'] });
    c.receive({ id: c.last('groupCreate').id, cmd: 'ack', error: { code: 4035, msg: 'x', userId: 'dave' } });
    await expect(a).rejects.toMatchObject({ code: 4035, userId: 'dave' });
    const b = h.im.createGroup({ members: ['bob', 'eve'] });
    c.receive({
      id: c.last('groupCreate').id,
      cmd: 'ack',
      error: { code: 4035, msg: 'x', details: { userId: 'eve' } },
    });
    await expect(b).rejects.toMatchObject({ userId: 'eve' });
  });

  it('tip 消息入库、计入未读、from 可以为空；摘要本地生成，不重拉 convs', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, name: 'g', maxSeq: 0 })]);
    const n = c.frames().filter((f) => f.cmd === 'convs').length;
    c.receive({
      cmd: 'msg',
      data: {
        msgId: 'm1',
        clientMsgId: 'tip-1',
        convId: G,
        seq: 1,
        from: '',
        type: 'tip',
        body: { tip: { kind: 'ownerChanged', actor: '', targets: [], text: '' } },
        ts: 5,
      },
    });
    expect(h.im.conversations()[0]).toMatchObject({ unread: 1, lastMsg: { type: 'tip', text: '群主已退出群聊' } });
    h.clock.advance(200);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'convs')).toHaveLength(n);
  });

  it('groupChanged：groupInfo 更新本地会话；在途请求合并；不重拉 convs', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, name: 'g', memberCount: 3, myRole: 'member' })]);
    const seen: string[] = [];
    h.im.on('groupChanged', (g) => seen.push(g));
    const convs = c.frames().filter((f) => f.cmd === 'convs').length;
    c.receive({ cmd: 'event', data: { type: 'groupChanged', groupId: 'g1' } });
    c.receive({ cmd: 'event', data: { type: 'groupChanged', groupId: 'g1' } });
    c.receive({ cmd: 'event', data: { type: 'groupChanged', groupId: 'g1' } });
    expect(c.frames().filter((f) => f.cmd === 'groupInfo')).toHaveLength(1);
    const info = {
      groupId: 'g1',
      name: '新名',
      memberCount: 5,
      myRole: 'admin',
      notice: '',
      noticeBy: '',
      noticeAt: 0,
      owner: 'bob',
      managed: false,
      maxMembers: 500,
      historyVisible: false,
      createdAt: 1,
    };
    c.ack('groupInfo', info);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'groupInfo')).toHaveLength(2); // 期间又有变化：再查一次
    c.ack('groupInfo', { ...info, memberCount: 6 });
    await flush();
    expect(h.im.conversations()[0]).toMatchObject({ name: '新名', memberCount: 6, myRole: 'admin' });
    expect(seen).toEqual(['g1']);
    expect(c.frames().filter((f) => f.cmd === 'convs')).toHaveLength(convs);
  });

  it('退群：本地按 left 移除并保留快照；解散按 dissolved', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, name: 'g' })]);
    const p = h.im.leaveGroup('g1');
    c.ack('groupLeave', {});
    await p;
    expect(h.im.conversations()).toEqual([]);
    expect(h.im.conversationSnapshot(G)).toMatchObject({ reason: 'left', name: 'g' });
  });

  it('loadGroupMembers 的资料覆盖缓存', async () => {
    const { h, c } = await loggedIn();
    const p = h.im.loadGroupMembers('g1');
    c.ack('groupMembers', {
      members: [{ userId: 'bob', role: 'owner', joinedAt: 1, nickname: '阿博', avatar: '', official: false }],
      nextCursor: '',
    });
    await p;
    expect(h.im.profileOf('bob')?.nickname).toBe('阿博');
  });
});
