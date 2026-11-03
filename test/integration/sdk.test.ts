// SDK 对真实服务端的集成测试：用标准 WebSocket，验证协议、错误码和关键流程在两端一致。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMClient, c2cConvId, type FatalReason, type Message } from '../../src/index.js';
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
