// SDK 对真实服务端的集成测试：用标准 WebSocket，验证协议、错误码和关键流程在两端一致。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMClient, c2cConvId, tipText, type FatalReason, type Message } from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

let srv: RunningServer;
const clients: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer();
});
afterAll(async () => {
  for (const c of clients) c.destroy();
  await srv?.stop();
});

function client(
  timings: Partial<ConstructorParameters<typeof IMClient>[0]['timings']> = {},
  url = () => srv.wsURL,
): IMClient {
  const im = new IMClient({ url: url(), browserEvents: false, timings });
  clients.push(im);
  return im;
}

/** 等到条件满足（轮询，最多 5 秒）。 */
async function until<T>(fn: () => T | undefined | false, what: string, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function login(userId: string, im = client()): Promise<IMClient> {
  im.connect(await srv.token(userId));
  await until(() => im.state === 'connected' && im.userId === userId, `${userId} connected`);
  return im;
}

describe('SDK × 真实服务端', () => {
  it('单聊收发、会话列表、未读、已读', async () => {
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'bob1', nickname: '鲍勃' }] });
    const alice = await login('alice1');
    const bob = await login('bob1');
    const conv = c2cConvId('alice1', 'bob1');
    const r = alice.send(conv, '  你好 👋  ');
    expect(r.ok).toBe(true);
    await until(() => alice.messages(conv)[0]?.status === 'sent', 'ack');
    expect(alice.messages(conv)[0]).toMatchObject({ seq: 1, body: { text: '你好 👋' } });
    // 第一次和 bob 聊天：本地先补临时会话，随后用服务端数据替换，会话名变成昵称。
    await until(() => alice.conversations()[0]?.name === '鲍勃', 'conversation refreshed from server');
    expect(alice.conversations()[0]).toMatchObject({ convId: conv, name: '鲍勃', unread: 0, readSeq: 1 });

    const got = await until(() => bob.messages(conv)[0], 'bob receives');
    expect(got).toMatchObject({ from: 'alice1', seq: 1, status: 'sent' });
    await until(() => bob.conversations().find((c) => c.convId === conv)?.unread === 1, 'bob unread 1');
    bob.setActiveConversation(conv);
    await until(() => bob.conversations()[0]?.unread === 0, 'bob read');
    // 服务端也记下了：重新登录后未读仍为 0（AC-CONV-02-2）。
    const bob2 = await login('bob1');
    await until(() => bob2.conversations().find((c) => c.convId === conv), 'bob2 convs');
    expect(bob2.conversations().find((c) => c.convId === conv)?.unread).toBe(0);
  });

  it('给不存在的用户发消息：4042 透传给界面（AC-CONV-03-3）', async () => {
    const alice = await login('alice2');
    const conv = c2cConvId('alice2', 'ghost');
    alice.send(conv, 'hi?');
    const m = await until(() => alice.messages(conv).find((x: Message) => x.status === 'failed'), 'failed');
    expect(m.error).toBe(4042);
  });

  it('ack 被丢弃后手动重发：对方只收到一条，msgId 与第一次一致（AC-MSG-03-4）', async () => {
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'bob3' }] });
    // 固定 clientMsgId，先设置故障注入（丢掉这条消息的 ack，服务端照常保存和投递），再发送。
    const alice = new IMClient({
      url: srv.wsURL,
      browserEvents: false,
      timings: { sendTimeoutMs: 800 },
      newId: () => 'lost-ack-0001',
    });
    clients.push(alice);
    await login('alice3', alice);
    const bob = await login('bob3');
    const conv = c2cConvId('alice3', 'bob3');
    await srv.admin('POST', '/admin/test/drop-ack', { clientMsgId: 'lost-ack-0001' });
    alice.send(conv, 'lost ack');
    const fromBob = await until(() => bob.messages(conv)[0], 'bob receives');
    await until(() => alice.messages(conv)[0]?.status === 'failed', 'times out');
    alice.retry(conv, 'lost-ack-0001');
    await until(() => alice.messages(conv)[0]?.status === 'sent', 'retry sent');
    await new Promise((r) => setTimeout(r, 300));
    expect(bob.messages(conv)).toHaveLength(1);
    expect(alice.messages(conv)).toHaveLength(1);
    expect(alice.messages(conv)[0]).toMatchObject({ msgId: fromBob.msgId, seq: 1 });
  });

  it('被拉进群收到 convAdded；群消息多端同步', async () => {
    const alice = await login('alice4');
    const carol = await login('carol4');
    await srv.admin('POST', '/admin/groups', { groupId: 'g4', name: '测试群', members: ['alice4', 'carol4'] });
    await until(() => carol.conversations().find((c) => c.convId === 'group:g4'), 'convAdded');
    expect(carol.conversations().find((c) => c.convId === 'group:g4')?.name).toBe('测试群');
    alice.send('group:g4', 'hello group');
    await until(() => carol.messages('group:g4')[0]?.body.text === 'hello group', 'carol receives');
  });

  it('被强制下线：停止重连，通知界面（AC-AUTH-03-2/5）', async () => {
    const alice = await login('alice5');
    const fatal: FatalReason[] = [];
    alice.on('fatal', (f) => fatal.push(f));
    await srv.admin('POST', '/admin/users/alice5/force-logout', {});
    await until(() => fatal.length > 0, 'fatal');
    expect(fatal[0]).toEqual({ kind: 'kicked', reason: 'banned', code: 4012 });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(alice.state).toBe('disconnected');
  });
});

describe('SDK × 真实服务端：社交（PRD-social FE-101～FE-103）', () => {
  it('申请 → 对方红点 → 同意 → 双方好友列表；多端同步', async () => {
    await srv.admin('POST', '/admin/users/import', {
      users: [
        { userId: 's1a', nickname: '小A' },
        { userId: 's1b', nickname: '小B' },
      ],
    });
    const a = await login('s1a');
    const b = await login('s1b');
    const bPc = await login('s1b');
    await until(() => a.socialLoaded() && b.socialLoaded() && bPc.socialLoaded(), 'first social round');
    const found = await a.searchUser('s1b');
    expect(found).toMatchObject({ nickname: '小B', relation: 'none' });
    expect(await a.applyFriend('s1b', { message: '我是小A', source: 'search' })).toBe('pending');
    expect(a.relationOf('s1b')).toBe('pendingOut');
    expect(a.friendRequests().items[0]).toMatchObject({
      userId: 's1b',
      direction: 'out',
      displayName: '小B',
      profile: null,
    });
    await until(
      () => b.friendRequests().unseen === 1 && bPc.friendRequests().unseen === 1,
      'b red dot on both devices',
    );
    expect(b.friendRequests().items[0]).toMatchObject({
      userId: 's1a',
      direction: 'in',
      message: '我是小A',
      displayName: '小A',
    });
    b.markFriendRequestsSeen();
    await until(() => bPc.friendRequests().unseen === 0, 'red dot cleared on the other device');
    await b.respondFriend('s1a', 'accept', { remark: '同学A' });
    expect(b.friends().map((f) => f.displayName)).toEqual(['同学A']);
    await until(() => a.friends().length === 1 && bPc.friends().length === 1, 'friends on both sides');
    expect(a.relationOf('s1b')).toBe('friend');
    expect(bPc.friends()[0]?.displayName).toBe('同学A');
  });

  it('拉黑：对方私聊 4036 标记失败、不自动重发；黑名单多端同步', async () => {
    const a = await login('s2a');
    const aPc = await login('s2a');
    const b = await login('s2b');
    await until(() => a.socialLoaded() && aPc.socialLoaded(), 'loaded');
    await a.block('s2b');
    expect(a.relationOf('s2b')).toBe('blocked');
    await until(() => aPc.blocks()[0]?.userId === 's2b', 'block synced');
    const conv = c2cConvId('s2a', 's2b');
    b.send(conv, 'hi');
    const m = await until(() => b.messages(conv).find((x) => x.status === 'failed'), 'failed');
    expect(m.error).toBe(4036);
    await new Promise((r) => setTimeout(r, 300));
    expect(b.messages(conv)).toHaveLength(1);
    await a.unblock('s2b');
    await until(() => aPc.blocks().length === 0, 'unblock synced');
  });

  it('getUsers 只返回可见的人；loadMyGroups；被管理接口移出群 reason=removed', async () => {
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 's3b', nickname: '群友' }, { userId: 's3c' }] });
    const a = await login('s3a');
    for (const g of ['s3g1', 's3g2', 's3g3'])
      await srv.admin('POST', '/admin/groups', { groupId: g, name: g, members: ['s3a', 's3b'] });
    expect((await a.loadMyGroups()).map((g) => [g.groupId, g.memberCount])).toEqual([
      ['s3g1', 2],
      ['s3g2', 2],
      ['s3g3', 2],
    ]);
    expect((await a.getUsers(['s3b', 's3c', 'nobody'])).map((u) => u.nickname)).toEqual(['群友']);
    const removed: Array<[string, string | undefined]> = [];
    a.on('convRemoved', (id, reason) => removed.push([id, reason]));
    await until(() => a.conversations().some((c) => c.convId === 'group:s3g1'), 'convs');
    await srv.admin('DELETE', '/admin/groups/s3g1/members', { members: ['s3a'] });
    await until(() => removed.length > 0, 'convRemoved');
    expect(removed[0]).toEqual(['group:s3g1', 'removed']);
  });
});

describe('SDK × 真实服务端：群管理（FE-110、FE-111）', () => {
  async function befriend(a: IMClient, aId: string, b: IMClient, bId: string): Promise<void> {
    await a.applyFriend(bId);
    await until(() => b.friendRequests().items.some((r) => r.userId === aId), 'request arrives');
    await b.respondFriend(aId, 'accept');
    await until(() => a.relationOf(bId) === 'friend', 'friends');
  }

  it('建群 → 提示消息 → 邀请 → 设管理员 → 改名 → 踢人 → 转让 → 退群 → 解散', async () => {
    await srv.admin('POST', '/admin/users/import', {
      users: ['gm_a', 'gm_b', 'gm_c', 'gm_d'].map((userId) => ({ userId, nickname: userId })),
    });
    const a = await login('gm_a');
    const b = await login('gm_b');
    const c = await login('gm_c');
    const d = await login('gm_d');
    await befriend(a, 'gm_a', b, 'gm_b');
    await befriend(a, 'gm_a', c, 'gm_c');
    await befriend(a, 'gm_a', d, 'gm_d');

    const { groupId, conv } = await a.createGroup({ members: ['gm_b', 'gm_c'] });
    expect(conv).toMatchObject({ type: 'group', myRole: 'owner', memberCount: 3 });
    const tipOf = (im: IMClient, kind: string) =>
      im.messages(conv.convId).find((m) => m.type === 'tip' && m.body.tip?.kind === kind);
    b.setActiveConversation(conv.convId);
    await until(() => b.conversations().find((x) => x.convId === conv.convId)?.myRole === 'member', 'b sees group');
    await b.loadHistory(conv.convId);
    const created = await until(() => tipOf(b, 'created'), 'created tip');
    expect(created.from).toBe('gm_a');
    expect(tipText(created.body.tip!, 'gm_b', (u) => u)).toBe('gm_a 创建了群聊');

    expect(await a.inviteToGroup(groupId, ['gm_d'])).toEqual({ added: ['gm_d'], failed: [] });
    await until(() => tipOf(b, 'joined'), 'joined tip');
    await until(
      () => b.conversations().find((x) => x.convId === conv.convId)?.memberCount === 4,
      'memberCount via groupChanged',
    );

    // 本地生成的摘要与服务端 lastMsg.text 一致（刷新前后不跳变）。
    const summaryOf = () => b.conversations().find((x) => x.convId === conv.convId)?.lastMsg?.text;
    expect(summaryOf()).toBe('gm_a 邀请 gm_d 加入了群聊');
    await b.refreshConversations();
    expect(summaryOf()).toBe('gm_a 邀请 gm_d 加入了群聊');

    await a.setGroupAdmin(groupId, 'gm_b', true);
    await until(() => b.conversations().find((x) => x.convId === conv.convId)?.myRole === 'admin', 'b becomes admin');

    await b.updateGroup(groupId, { name: '周六球局', notice: '九点' });
    // 操作者不刷新也能看到自己的提示消息（AC-UI-37-1、39-1）。
    await until(
      () => b.conversations().find((x) => x.convId === conv.convId)?.lastMsg?.text?.includes('公告') === true,
      'operator sees own tip',
    );
    expect(b.conversations().find((x) => x.convId === conv.convId)?.unread).toBe(0);
    await until(() => a.conversations().find((x) => x.convId === conv.convId)?.name === '周六球局', 'renamed');
    expect(await a.getGroupInfo(groupId)).toMatchObject({
      notice: '九点',
      noticeBy: 'gm_b',
      owner: 'gm_a',
      managed: false,
    });

    // 管理员不能动群主；错误码原样透传。
    await expect(b.kickFromGroup(groupId, ['gm_a'])).rejects.toMatchObject({ code: 4030 });
    expect(await b.kickFromGroup(groupId, ['gm_d'])).toEqual(['gm_d']);
    await until(() => d.conversationSnapshot(conv.convId)?.reason === 'removed', 'd removed');

    const page = await a.loadGroupMembers(groupId);
    expect(page.members.map((m) => [m.userId, m.role])).toEqual([
      ['gm_a', 'owner'],
      ['gm_b', 'admin'],
      ['gm_c', 'member'],
    ]);

    await a.transferGroupOwner(groupId, 'gm_c');
    await until(() => c.conversations().find((x) => x.convId === conv.convId)?.myRole === 'owner', 'c becomes owner');
    await a.leaveGroup(groupId);
    expect(a.conversations().some((x) => x.convId === conv.convId)).toBe(false);
    expect(a.conversationSnapshot(conv.convId)?.reason).toBe('left');

    await c.dissolveGroup(groupId);
    await until(() => b.conversationSnapshot(conv.convId)?.reason === 'dissolved', 'b sees dissolved');
  });

  it('建群失败带 userId：不是好友的人返回 4035', async () => {
    await srv.admin('POST', '/admin/users/import', {
      users: ['gm_e', 'gm_f', 'gm_g'].map((userId) => ({ userId, nickname: userId })),
    });
    const e = await login('gm_e');
    await befriend(e, 'gm_e', await login('gm_f'), 'gm_f');
    await expect(e.createGroup({ members: ['gm_f', 'gm_g'] })).rejects.toMatchObject({ code: 4035, userId: 'gm_g' });
  });
});

describe('SDK × 真实服务端：断线重连与补拉', () => {
  let idle: RunningServer;
  beforeAll(async () => {
    // 服务端 1 秒空闲超时、客户端 60 秒才发心跳：服务端会以 4408 断开，SDK 应该自动重连并补拉（AC-CONN-01-4）。
    idle = await startServer({ IM_IDLE_TIMEOUT: '1s' });
  });
  afterAll(async () => {
    await idle?.stop();
  });

  it('被服务端断开后自动重连，断线期间的消息按序补齐、不重复', async () => {
    await idle.admin('POST', '/admin/users/import', { users: [{ userId: 'bob6' }] });
    const alice = client({ heartbeatMs: 60_000, backoffBaseMs: 200 }, () => idle.wsURL);
    alice.connect(await idle.token('alice6'));
    const bobTok = await idle.token('bob6');
    const bob = client({ heartbeatMs: 300 }, () => idle.wsURL);
    bob.connect(bobTok);
    await until(() => alice.state === 'connected' && bob.state === 'connected', 'both connected');
    const conv = c2cConvId('alice6', 'bob6');
    bob.send(conv, 'm1');
    await until(() => alice.messages(conv).length === 1, 'first message');
    const states: string[] = [];
    alice.on('state', (s) => states.push(s));
    await until(() => states.includes('disconnected'), 'idle disconnect', 5_000);
    // alice 断线期间 bob 连发 3 条
    for (const t of ['m2', 'm3', 'm4']) bob.send(conv, t);
    await until(() => alice.messages(conv).length === 4, 'caught up', 8_000);
    expect(alice.messages(conv).map((m) => m.body.text)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(alice.messages(conv).map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });
});
