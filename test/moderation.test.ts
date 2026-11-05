// PRD-admin 第二批（FE-431、FE-432、FE-433）：封禁、消息删除、禁言。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FatalReason, IMClient, Message } from '../src/index.js';
import { FakeClock } from '../src/testing/index.js';
import { conv, flush, msg, setup, type Harness } from './helpers.js';

const AB = 'c2c:alice:bob';
const G1 = 'group:g1';
const G2 = 'group:g2';
const SECRET = 'ZXQ-DEL-555';

/** 走一遍对象图（Map、Set、数组、私有字段），找内存里任何一份副本。比 debugExport 更严：不依赖导出函数写对。 */
function holds(root: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof root === 'string') return root.includes(needle);
  if (typeof root !== 'object' || root === null || seen.has(root)) return false;
  seen.add(root);
  if (root instanceof Map)
    return [...root.entries()].some(([k, v]) => holds(k, needle, seen) || holds(v, needle, seen));
  if (root instanceof Set) return [...root].some((v) => holds(v, needle, seen));
  return Object.values(root).some((v) => holds(v, needle, seen));
}

const storeOf = (im: IMClient) => (im as unknown as { store: unknown }).store;

function expectClean(h: Harness) {
  expect(JSON.stringify(h.im.debugExport())).not.toContain(SECRET);
  expect(JSON.stringify(h.im.conversations())).not.toContain(SECRET);
  expect(holds(storeOf(h.im), SECRET)).toBe(false);
}

const deletedEvent = (convId: string, msgIds: string[], seqs: number[]) => ({
  cmd: 'event',
  data: { type: 'msgDeleted', convId, msgIds, seqs },
});

const deletedMsg = (convId: string, seq: number, from = 'bob') => {
  const { body: _, ...rest } = msg(convId, seq, from);
  return { ...rest, deleted: true, deletedAt: 5000 };
};

describe('封禁（FE-431、AC-ADM-13-1、AC-ADM-13-11）', () => {
  function kickWatch(h: Harness) {
    const fatal: FatalReason[] = [];
    h.im.on('fatal', (r) => fatal.push(r));
    return fatal;
  }

  it('kicked {suspended, until} + 4012：fatal 带 until，退避时间过后、网络恢复时都不重连', async () => {
    const h = setup();
    const fatal = kickWatch(h);
    h.im.connect('t');
    const c = await h.login();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'suspended', until: 1_730_000_000_000 } });
    c.drop(4012, 'suspended');
    expect(fatal).toEqual([{ kind: 'kicked', reason: 'suspended', code: 4012, until: 1_730_000_000_000 }]);
    h.clock.advance(300_000);
    h.im.networkOnline();
    expect(h.transport.connections).toHaveLength(1);
    expect(h.im.state).toBe('disconnected');
  });

  it('永久封禁 until = null 原样透传（不是"没有 until"）', async () => {
    const h = setup();
    const fatal = kickWatch(h);
    h.im.connect('t');
    const c = await h.login();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'suspended', until: null } });
    c.drop(4012);
    expect(fatal[0]).toStrictEqual({ kind: 'kicked', reason: 'suspended', code: 4012, until: null });
  });

  it('握手阶段用旧 token：auth 的 ack 之前收到 kicked，同样不重连', async () => {
    const h = setup();
    const fatal = kickWatch(h);
    h.im.connect('old');
    const c = h.transport.current;
    c.open();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'suspended', until: null } });
    c.drop(4012);
    expect(fatal[0]).toMatchObject({ kind: 'kicked', reason: 'suspended', until: null });
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });

  it('不认识的 reason + 4012、以及只有关闭码 4012：都不重连，没有 until', async () => {
    for (const kicked of [true, false]) {
      const h = setup();
      const fatal = kickWatch(h);
      h.im.connect('t');
      const c = await h.login();
      if (kicked) c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'xyz' } });
      c.drop(4012);
      expect(fatal[0]).toStrictEqual(
        kicked ? { kind: 'kicked', reason: 'xyz', code: 4012 } : { kind: 'closed', code: 4012, reason: '' },
      );
      h.clock.advance(60_000);
      expect(h.transport.connections).toHaveLength(1);
    }
  });
});

describe('消息删除（FE-432、AC-ADM-31-1、AC-ADM-31-3、AC-ADM-31-5）', () => {
  async function chat(h: Harness, unread = 0) {
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1, maxSeq: 0, unread })]);
    c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', 'keep me') });
    c.receive({ cmd: 'msg', data: msg(G1, 2, 'bob', `秘密 ${SECRET}`) });
    c.receive({ cmd: 'msg', data: msg(G1, 3, 'bob', 'tail') });
    return c;
  }

  it('msgDeleted：原文从内存消失，seq 不留空洞，别的消息不受影响，未读不变', async () => {
    const h = setup();
    const c = await chat(h);
    const unread = h.im.conversations()[0]!.unread;
    expect(unread).toBe(3);
    expect(holds(storeOf(h.im), SECRET)).toBe(true); // 对照：删除之前确实在内存里
    const seen: Message[][] = [];
    h.im.on('messages', (_id, list) => seen.push(list));
    c.receive(deletedEvent(G1, [`${G1}#2`], [2]));
    expectClean(h);
    const list = h.im.messages(G1);
    expect(list.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(list[1]).toMatchObject({ msgId: `${G1}#2`, from: 'bob', deleted: true, body: {} });
    expect(list[0]?.body.text).toBe('keep me');
    expect(list[2]?.body.text).toBe('tail');
    expect(seen).toHaveLength(1);
    expect(h.im.conversations()[0]!.unread).toBe(unread);
    expect(h.im.conversations()[0]!.lastMsg?.text).toBe('tail'); // 不是最后一条：摘要不动
  });

  it('删的是最后一条：摘要改成占位（没有 text），未读不变；新消息之后摘要恢复', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1 })]);
    c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', SECRET) });
    expect(h.im.conversations()[0]!.lastMsg?.text).toBe(SECRET);
    const views: unknown[] = [];
    h.im.on('conversations', (l) => views.push(l[0]?.lastMsg));
    c.receive(deletedEvent(G1, [`${G1}#1`], [1]));
    expect(views.at(-1)).toMatchObject({ deleted: true, msgId: `${G1}#1` });
    expect(h.im.conversations()[0]!.lastMsg).not.toHaveProperty('text');
    expect(h.im.conversations()[0]!.unread).toBe(1);
    expectClean(h);
    c.receive({ cmd: 'msg', data: msg(G1, 2, 'bob', 'fresh') });
    expect(h.im.conversations()[0]!.lastMsg).toMatchObject({ text: 'fresh' });
    expect(h.im.conversations()[0]!.lastMsg?.deleted).toBeUndefined();
  });

  it('sync 回来的 deleted 消息（没有 body）：不崩溃，占位；是最后一条时摘要也占位', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1, maxSeq: 2, unread: 2 })]);
    const p = h.im.loadHistory(G1);
    c.ack('sync', { messages: [msg(G1, 1), deletedMsg(G1, 2)], hasMore: false });
    await p;
    expect(h.im.messages(G1)[1]).toMatchObject({ seq: 2, deleted: true, deletedAt: 5000, body: {}, status: 'sent' });
    expect(h.im.conversations()[0]!.unread).toBe(2);
  });

  it('删除之前发出的 sync 晚到，带着原文：不能写回来（含还没加载过的消息）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1, maxSeq: 2 })]);
    const p = h.im.loadHistory(G1);
    c.receive(deletedEvent(G1, [`${G1}#2`], [2]));
    c.ack('sync', { messages: [msg(G1, 1), msg(G1, 2, 'bob', SECRET)], hasMore: false });
    await p;
    expectClean(h);
    expect(h.im.messages(G1)[1]?.deleted).toBe(true);
  });

  it('删除之前生成的 convs 晚到，摘要带着原文：不能写回来', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1 })]);
    c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', SECRET) });
    c.receive(deletedEvent(G1, [`${G1}#1`], [1]));
    h.clock.advance(31_000);
    const p = h.im.refreshConversations();
    c.ack('convs', {
      convs: [
        conv({
          convId: G1,
          maxSeq: 1,
          lastMsg: { msgId: `${G1}#1`, from: 'bob', type: 'text', text: SECRET, ts: 1 },
        }),
      ],
      truncated: false,
    });
    await p;
    expectClean(h);
    expect(h.im.conversations()[0]!.lastMsg?.deleted).toBe(true);
  });

  it('自己刚发的消息：删除事件先于 ack 到达，ack 不把原文写回来', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.send(AB, SECRET);
    c.receive(deletedEvent(AB, ['m9'], [9]));
    c.ack('send', { msgId: 'm9', convId: AB, seq: 9, ts: 5 });
    await flush();
    expectClean(h);
    expect(h.im.messages(AB)).toHaveLength(1);
    expect(h.im.messages(AB)[0]).toMatchObject({ seq: 9, deleted: true, status: 'sent' });
    expect(h.im.conversations()[0]!.lastMsg?.deleted).toBe(true);
  });

  it('超时标记失败的本地消息：事件只有 msgId，补拉后按 clientMsgId 对上，队列里的原文也清掉，不能再重发', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    const r = h.im.send(AB, SECRET);
    if (!r.ok) throw new Error('send failed');
    h.clock.advance(10_000);
    await flush();
    expect(h.im.messages(AB)[0]).toMatchObject({ status: 'failed', error: 'timeout' });
    c.receive(deletedEvent(AB, ['m9'], [9]));
    expect(c.last('sync').data).toEqual({ convId: AB, afterSeq: 8, limit: 200 });
    c.ack('sync', {
      messages: [{ ...deletedMsg(AB, 9, 'alice'), msgId: 'm9', clientMsgId: r.message.clientMsgId }],
      hasMore: false,
    });
    await flush();
    expectClean(h);
    expect(h.im.messages(AB)).toHaveLength(1);
    expect(h.im.pendingCount()).toBe(0);
    const before = c.frames().filter((f) => f.cmd === 'send').length;
    h.im.retry(AB, r.message.clientMsgId);
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(before);
  });

  it('断开期间被删除（没有事件）：重连后重新拉已加载的范围，清掉原文', async () => {
    const h = setup();
    const c1 = await chat(h);
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    await flush();
    c2.ack('convs', { convs: [conv({ convId: G1, maxSeq: 3, unread: 3 })], truncated: false });
    await flush();
    expect(c2.last('sync').data).toEqual({ convId: G1, afterSeq: 0, limit: 200 });
    c2.ack('sync', { messages: [msg(G1, 1), deletedMsg(G1, 2), msg(G1, 3)], hasMore: false });
    await flush();
    expectClean(h);
    expect(h.im.messages(G1).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(h.im.conversations()[0]!.unread).toBe(3);
  });

  it('convs 的 lastMsg.deleted：错过事件时本地那条也清掉，摘要占位', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1 })]);
    c.receive({ cmd: 'msg', data: msg(G1, 1, 'bob', SECRET) });
    h.clock.advance(31_000);
    const p = h.im.refreshConversations();
    c.ack('convs', {
      convs: [
        conv({
          convId: G1,
          maxSeq: 1,
          unread: 1,
          lastMsg: { msgId: `${G1}#1`, from: 'bob', type: 'text', ts: 1, deleted: true },
        }),
      ],
      truncated: false,
    });
    await p;
    expectClean(h);
    expect(h.im.conversations()[0]).toMatchObject({ unread: 1, lastMsg: { deleted: true } });
  });

  it('debugExport 是拷贝，不包含 token', async () => {
    const h = setup();
    h.im.connect('secret-token-xyz');
    const c = await h.login('alice', [conv({ convId: G1 })]);
    c.receive({ cmd: 'msg', data: msg(G1, 1) });
    const dump = h.im.debugExport();
    expect(JSON.stringify(dump)).not.toContain('secret-token-xyz');
    dump.messages[G1]![0]!.body.text = 'changed';
    expect(h.im.messages(G1)[0]?.body.text).toBe('m1');
  });
});

describe('禁言（FE-433、AC-ADM-40-4、40-5、40-6、41-6）', () => {
  const muted = (d: Record<string, unknown>) => ({ cmd: 'event', data: { type: 'muted', ...d } });
  const unmuted = (d: Record<string, unknown>) => ({ cmd: 'event', data: { type: 'unmuted', ...d } });
  const convs = () => [conv({ convId: AB }), conv({ convId: G1 }), conv({ convId: G2 })];

  async function online(h: Harness) {
    h.im.connect('t');
    return h.login('alice', convs());
  }

  it('用户级：所有会话都禁言；永久为 null；unmuted 解除并发事件', async () => {
    const h = setup();
    const c = await online(h);
    let events = 0;
    h.im.on('muteChanged', () => events++);
    const until = h.clock.now() + 600_000;
    c.receive(muted({ scope: 'user', mutedUntil: until }));
    for (const id of [AB, G1, G2]) expect(h.im.muteState(id)).toEqual({ scope: 'user', mutedUntil: until });
    expect(events).toBe(1);
    c.receive(muted({ scope: 'user', mutedUntil: null }));
    expect(h.im.muteState(AB)).toEqual({ scope: 'user', mutedUntil: null });
    c.receive(unmuted({ scope: 'user' }));
    for (const id of [AB, G1, G2]) expect(h.im.muteState(id)).toBeNull();
    expect(events).toBe(3);
  });

  it('群内禁言只影响该群；用户级优先；解除用户级后群内禁言还在', async () => {
    const h = setup();
    const c = await online(h);
    const until = h.clock.now() + 3_600_000;
    c.receive(muted({ scope: 'group', groupId: 'g1', mutedUntil: until }));
    expect(h.im.muteState(G1)).toEqual({ scope: 'group', groupId: 'g1', mutedUntil: until });
    expect(h.im.muteState(G2)).toBeNull();
    expect(h.im.muteState(AB)).toBeNull();
    c.receive(muted({ scope: 'user', mutedUntil: h.clock.now() + 60_000 }));
    expect(h.im.muteState(G1)?.scope).toBe('user');
    c.receive(unmuted({ scope: 'user' }));
    expect(h.im.muteState(G1)).toEqual({ scope: 'group', groupId: 'g1', mutedUntil: until });
    c.receive(unmuted({ scope: 'group', groupId: 'g2' })); // 别的群解除不影响 g1
    expect(h.im.muteState(G1)?.scope).toBe('group');
    c.receive(unmuted({ scope: 'group', groupId: 'g1' }));
    expect(h.im.muteState(G1)).toBeNull();
  });

  it('不认识的 scope 忽略', async () => {
    const h = setup();
    const c = await online(h);
    c.receive(muted({ scope: 'groupAll', groupId: 'g1', mutedUntil: null }));
    expect(h.im.muteState(G1)).toBeNull();
  });

  it('auth ack 的 mutedUntil：离线被禁言上线即禁用；永久 null；重连时没有这个字段表示已解除（AC-ADM-40-6）', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = h.transport.current;
    c1.open();
    const until = h.clock.now() + 86_400_000;
    c1.ack('auth', { userId: 'alice', serverTime: h.clock.now(), mutedUntil: until });
    expect(h.im.muteState(AB)).toEqual({ scope: 'user', mutedUntil: until });
    await flush();
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: h.clock.now(), mutedUntil: null });
    expect(h.im.muteState(AB)).toEqual({ scope: 'user', mutedUntil: null });
    await flush();
    c2.drop(1006);
    h.clock.advance(5_000);
    const c3 = h.transport.current;
    c3.open();
    c3.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    expect(h.im.muteState(AB)).toBeNull();
  });

  it('convs 的 mutedUntil：只有该群；永久 null；下一次 convs 没有这个字段时解除（AC-ADM-41-6）', async () => {
    const h = setup();
    h.im.connect('t');
    const until = h.clock.now() + 3_600_000;
    const c = await h.login('alice', [
      conv({ convId: G1, mutedUntil: until }),
      conv({ convId: G2 }),
      conv({ convId: AB }),
    ]);
    expect(h.im.muteState(G1)).toEqual({ scope: 'group', groupId: 'g1', mutedUntil: until });
    expect(h.im.muteState(G2)).toBeNull();
    expect(h.im.muteState(AB)).toBeNull();
    expect(h.im.conversations().find((x) => x.convId === G1)).not.toHaveProperty('mutedUntil');
    h.clock.advance(31_000);
    let p = h.im.refreshConversations();
    c.ack('convs', { convs: [conv({ convId: G1, mutedUntil: null }), conv({ convId: G2 })], truncated: false });
    await p;
    expect(h.im.muteState(G1)?.mutedUntil).toBeNull();
    c.receive({ cmd: 'pong' }); // 60 秒内要回一次心跳，否则连接按断线处理
    h.clock.advance(31_000);
    p = h.im.refreshConversations();
    c.ack('convs', { convs: [conv({ convId: G1 }), conv({ convId: G2 })], truncated: false });
    await p;
    expect(h.im.muteState(G1)).toBeNull();
  });

  it('发送返回 4031：消息失败、状态按 details 更新，sendFailed 一次；重连后不自动重发', async () => {
    const h = setup();
    const c1 = await online(h);
    const failed: unknown[] = [];
    h.im.on('sendFailed', (...a) => failed.push(a));
    const r = h.im.send(G1, 'x');
    if (!r.ok) throw new Error('send');
    const until = h.clock.now() + 600_000;
    c1.receive({
      id: c1.last('send').id,
      cmd: 'ack',
      error: { code: 4031, msg: 'muted', details: { scope: 'group', groupId: 'g1', mutedUntil: until } },
    });
    await flush();
    expect(h.im.messages(G1)[0]).toMatchObject({ status: 'failed', error: 4031 });
    expect(h.im.muteState(G1)).toEqual({ scope: 'group', groupId: 'g1', mutedUntil: until });
    expect(h.im.muteState(G2)).toBeNull();
    expect(failed).toEqual([[G1, r.message.clientMsgId, 4031]]);
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    await flush();
    expect(c2.frames().filter((f) => f.cmd === 'send')).toHaveLength(0);
  });

  it('4031 永久（用户级）：mutedUntil = null；缺 details 时只标记失败', async () => {
    const h = setup();
    const c = await online(h);
    h.im.send(AB, 'x');
    c.receive({
      id: c.last('send').id,
      cmd: 'ack',
      error: { code: 4031, msg: 'muted', details: { scope: 'user', mutedUntil: null } },
    });
    await flush();
    expect(h.im.muteState(G2)).toEqual({ scope: 'user', mutedUntil: null });
    const h2 = setup();
    const c2 = await online(h2);
    h2.im.send(AB, 'x');
    c2.ackError('send', 4031);
    await flush();
    expect(h2.im.messages(AB)[0]).toMatchObject({ status: 'failed', error: 4031 });
    expect(h2.im.muteState(AB)).toBeNull();
  });

  it.each([
    ['本机时钟比服务端慢 1 小时', 3_600_000],
    ['本机时钟比服务端快 1 小时', -3_600_000],
  ])('到期按服务端时间恢复：%s', async (_name, skew) => {
    const h = setup();
    h.im.connect('t');
    const c = h.transport.current;
    c.open();
    const serverNow = h.clock.now() + skew;
    c.ack('auth', { userId: 'alice', serverTime: serverNow });
    await flush();
    c.ack('convs', { convs: convs(), truncated: false });
    await flush();
    let events = 0;
    h.im.on('muteChanged', () => events++);
    c.receive(muted({ scope: 'user', mutedUntil: serverNow + 600_000 }));
    expect(events).toBe(1);
    h.clock.advance(599_999);
    expect(h.im.muteState(AB)).not.toBeNull();
    expect(events).toBe(1);
    h.clock.advance(1);
    expect(h.im.muteState(AB)).toBeNull();
    expect(events).toBe(2); // 没有收到 unmuted，也发事件让界面恢复
  });

  it('30 天禁言：不会因为定时器上限提前解除；群内和用户级各自到期', async () => {
    // 真实的 setTimeout 超过 2^31-1 毫秒（约 24.8 天）会立即触发，假时钟要照样模拟才测得出来。
    class OverflowClock extends FakeClock {
      override setTimeout(fn: () => void, ms: number) {
        return super.setTimeout(fn, ms > 2_147_483_647 ? 1 : ms);
      }
    }
    const h = setup({ clock: new OverflowClock() });
    const c = await online(h);
    const day = 86_400_000;
    c.receive(muted({ scope: 'user', mutedUntil: h.clock.now() + 30 * day }));
    c.receive(muted({ scope: 'group', groupId: 'g1', mutedUntil: h.clock.now() + 40 * day }));
    h.clock.advance(29 * day);
    expect(h.im.muteState(AB)?.scope).toBe('user');
    h.clock.advance(day);
    expect(h.im.muteState(AB)).toBeNull();
    expect(h.im.muteState(G1)?.scope).toBe('group');
    h.clock.advance(10 * day);
    expect(h.im.muteState(G1)).toBeNull();
    expect((h.im as unknown as { muteTimer: unknown }).muteTimer).toBeNull(); // 没有留下定时器循环
  });

  it('被移出群清除群内禁言，再次入群不继承（F-ADM-41 规则 4）；退出登录清空', async () => {
    const h = setup();
    const c = await online(h);
    c.receive(muted({ scope: 'group', groupId: 'g1', mutedUntil: null }));
    c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G1, reason: 'removed' } });
    c.receive({ cmd: 'event', data: { type: 'convAdded', conv: conv({ convId: G1 }) } });
    expect(h.im.muteState(G1)).toBeNull();
    c.receive(muted({ scope: 'user', mutedUntil: null }));
    h.im.disconnect();
    expect(h.im.muteState(AB)).toBeNull();
  });

  it('muteState 读取本身按服务端时间判断（定时器晚到也不会显示已过期的禁言）', async () => {
    const h = setup();
    const c = await online(h);
    c.receive(muted({ scope: 'user', mutedUntil: h.clock.now() - 1 }));
    expect(h.im.muteState(AB)).toBeNull();
  });
});

describe('协议用例 protocol/vectors/frames.json', () => {
  it('所有合法的下行 event / msg 帧都能处理，不抛异常', async () => {
    const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/frames.json', import.meta.url), 'utf8')) as {
      valid: Array<{ name: string; frame: { cmd: string } }>;
    };
    const frames = spec.valid.filter((v) => v.frame.cmd === 'event' || v.frame.cmd === 'msg');
    expect(frames.map((f) => f.name)).toEqual(
      expect.arrayContaining(['event msgDeleted', 'event muted group', 'event unmuted', 'deleted message']),
    );
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G1 })]);
    for (const f of frames) if (!JSON.stringify(f.frame).includes('kicked')) c.receive(f.frame);
    await flush();
    expect(h.logs.filter((l) => l.includes('listener error'))).toEqual([]);
    expect(h.im.state).toBe('connected');
  });
});
