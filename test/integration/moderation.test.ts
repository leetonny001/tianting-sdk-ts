// PRD-admin 第二批 × 真实服务端（IM_V13_ADMIN_FEATURES=1）：封禁、消息删除、禁言。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMClient, c2cConvId, type FatalReason } from '../../src/index.js';
import { MODERATION_ENV, startServer, type RunningServer } from './server.js';

let srv: RunningServer;
const clients: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer(MODERATION_ENV);
});
afterAll(async () => {
  for (const c of clients) c.destroy();
  await srv?.stop();
});

async function until<T>(fn: () => T | undefined | false | null, what: string, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function client(): IMClient {
  const im = new IMClient({ url: srv.wsURL, browserEvents: false, timings: { backoffBaseMs: 50, backoffMaxMs: 100 } });
  clients.push(im);
  return im;
}

async function login(userId: string): Promise<IMClient> {
  const im = client();
  im.connect(await srv.token(userId));
  await until(() => im.state === 'connected' && im.userId === userId, `${userId} connected`);
  return im;
}

let n = 0;
const uid = (base: string) => `${base}${Date.now().toString(36)}${n++}`;

async function group(...members: string[]) {
  const groupId = uid('g');
  await srv.admin('POST', '/admin/users/import', { users: members.map((userId) => ({ userId })) });
  await srv.admin('POST', '/admin/groups', { groupId, name: groupId, members });
  return { groupId, convId: `group:${groupId}` };
}

describe('封禁（AC-ADM-13-1、AC-ADM-13-11）', () => {
  it('两个在线连接都收到 suspended + until，不重连；旧 token 握手时同样被踢', async () => {
    const u = uid('ban');
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: u }] });
    const oldToken = await srv.token(u);
    const [a, b] = [await login(u), await login(u)];
    const fatal: FatalReason[] = [];
    a.on('fatal', (r) => fatal.push(r));
    b.on('fatal', (r) => fatal.push(r));
    const before = Date.now();
    await srv.signed('POST', `/admin/users/${u}/ban`, { durationSeconds: 86_400, reason: 'it' });
    await until(() => fatal.length === 2, 'both kicked');
    for (const r of fatal) {
      expect(r).toMatchObject({ kind: 'kicked', reason: 'suspended', code: 4012 });
      const when = (r as { until: number }).until;
      expect(Math.abs(when - before - 86_400_000)).toBeLessThan(5_000);
    }
    await new Promise((r) => setTimeout(r, 300)); // 退避上限 100ms：如果重连，这段时间内就连上了
    expect(a.state).toBe('disconnected');
    expect(b.state).toBe('disconnected');

    const late = client();
    const lateFatal: FatalReason[] = [];
    late.on('fatal', (r) => lateFatal.push(r));
    late.connect(oldToken);
    await until(() => lateFatal.length === 1, 'old token kicked');
    expect(lateFatal[0]).toMatchObject({ kind: 'kicked', reason: 'suspended', code: 4012 });
  });

  it('永久封禁 until = null', async () => {
    const u = uid('ban');
    const im = await login(u);
    let got: FatalReason | undefined;
    im.on('fatal', (r) => (got = r));
    await srv.signed('POST', `/admin/users/${u}/ban`, { durationSeconds: null, reason: 'it' });
    await until(() => got, 'kicked');
    expect(got).toMatchObject({ kind: 'kicked', reason: 'suspended', until: null });
  });
});

describe('消息删除（AC-ADM-31-1、AC-ADM-31-3、AC-ADM-31-5）', () => {
  it('在线的 4 个连接都清除原文；导出搜不到特征串；摘要占位，未读不变；离线的上线后 sync 也一样', async () => {
    const [s, m1, m2, off] = [uid('s'), uid('m'), uid('m'), uid('off')];
    const { convId } = await group(s, m1, m2, off);
    const [a, a2, b, c] = [await login(s), await login(s), await login(m1), await login(m2)];
    const secret = `ZXQ-DEL-${uid('x')}`;
    a.send(convId, secret);
    // 收发两端都要先把这条放进内存（群建好时可能还有提示消息，按特征串找）。
    const find = (x: IMClient) => x.messages(convId).find((m) => m.body.text === secret);
    await until(() => find(a)?.status === 'sent', 'ack');
    const msgId = find(a)!.msgId!;
    for (const x of [a2, b, c]) await until(() => find(x), 'delivered');
    const unread = b.conversations().find((x) => x.convId === convId)!.unread;
    expect(unread).toBeGreaterThan(0);

    await srv.signed('POST', '/admin/messages/delete', { convId, msgIds: [msgId], reason: 'it' });
    for (const x of [a, a2, b, c]) {
      await until(() => x.messages(convId).find((m) => m.msgId === msgId)?.deleted, 'deleted');
      expect(JSON.stringify(x.debugExport())).not.toContain(secret);
      expect(x.conversations().find((v) => v.convId === convId)!.lastMsg).toMatchObject({ msgId, deleted: true });
    }
    expect(b.conversations().find((x) => x.convId === convId)!.unread).toBe(unread);

    const offline = await login(off);
    await until(() => offline.conversations().some((x) => x.convId === convId), 'offline convs');
    const v = offline.conversations().find((x) => x.convId === convId)!;
    expect(v.lastMsg).toMatchObject({ deleted: true });
    expect(v.lastMsg).not.toHaveProperty('text');
    const unreadBefore = v.unread;
    await offline.loadHistory(convId);
    expect(offline.messages(convId).at(-1)).toMatchObject({ msgId, deleted: true, body: {} });
    expect(JSON.stringify(offline.debugExport())).not.toContain(secret);
    expect(offline.conversations().find((x) => x.convId === convId)!.unread).toBe(unreadBefore);
  });
});

describe('禁言（AC-ADM-40-4、40-5、40-6、41-6）', () => {
  it('用户级：muted 事件 → 全部会话禁言，发送 4031 不重试；解除后发送成功', async () => {
    const [u, p] = [uid('u'), uid('p')];
    const { convId } = await group(u, p);
    const im = await login(u);
    const c2c = c2cConvId(u, p);
    await srv.signed('POST', '/admin/mute', { scope: 'user', userId: u, durationSeconds: 600, reason: 'it' });
    await until(() => im.muteState(convId), 'muted');
    expect(im.muteState(c2c)?.scope).toBe('user');
    expect(im.muteState(convId)!.mutedUntil!).toBeGreaterThan(im.serverNow());

    const r = im.send(convId, 'x');
    if (!r.ok) throw new Error('send');
    const id = r.message.clientMsgId;
    const mine = () => im.messages(convId).find((m) => m.clientMsgId === id);
    await until(() => mine()?.status === 'failed', '4031');
    expect(mine()).toMatchObject({ error: 4031 });

    await srv.signed('POST', '/admin/unmute', { scope: 'user', userId: u, reason: 'it' });
    await until(() => im.muteState(convId) === null, 'unmuted');
    const back = im.send(convId, 'back');
    if (!back.ok) throw new Error('send');
    await until(
      () => im.messages(convId).find((m) => m.clientMsgId === back.message.clientMsgId)?.status === 'sent',
      'sent',
    );
  });

  it('离线时用户级禁言：auth ack 带 mutedUntil，一上线就禁言；永久为 null', async () => {
    const u = uid('u');
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: u }] });
    await srv.signed('POST', '/admin/mute', { scope: 'user', userId: u, durationSeconds: null, reason: 'it' });
    const im = await login(u);
    expect(im.muteState(c2cConvId(u, 'other'))).toEqual({ scope: 'user', mutedUntil: null });
  });

  it('离线时群内禁言：convs 带 mutedUntil，只有该群；在线时 muted 事件也只影响该群', async () => {
    const [u, p] = [uid('u'), uid('p')];
    const g1 = await group(u, p);
    const g2 = await group(u, p);
    await srv.signed('POST', '/admin/mute', {
      scope: 'group',
      groupId: g1.groupId,
      userId: u,
      durationSeconds: 3600,
      reason: 'it',
    });
    const im = await login(u);
    await until(() => im.muteState(g1.convId), 'g1 muted from convs');
    expect(im.muteState(g1.convId)).toMatchObject({ scope: 'group', groupId: g1.groupId });
    expect(im.muteState(g2.convId)).toBeNull();
    expect(im.muteState(c2cConvId(u, p))).toBeNull();

    const ok = im.send(g2.convId, 'ok');
    const no = im.send(g1.convId, 'no');
    if (!ok.ok || !no.ok) throw new Error('send');
    await until(
      () => im.messages(g2.convId).find((m) => m.clientMsgId === ok.message.clientMsgId)?.status === 'sent',
      'g2 sent',
    );
    await until(
      () => im.messages(g1.convId).find((m) => m.clientMsgId === no.message.clientMsgId)?.status === 'failed',
      'g1 4031',
    );

    await srv.signed('POST', '/admin/unmute', { scope: 'group', groupId: g1.groupId, userId: u, reason: 'it' });
    await until(() => im.muteState(g1.convId) === null, 'g1 unmuted');
    await srv.signed('POST', '/admin/mute', {
      scope: 'group',
      groupId: g2.groupId,
      userId: u,
      durationSeconds: null,
      reason: 'it',
    });
    await until(() => im.muteState(g2.convId), 'g2 muted by event');
    expect(im.muteState(g2.convId)?.mutedUntil).toBeNull();
    expect(im.muteState(g1.convId)).toBeNull();
  });
});
