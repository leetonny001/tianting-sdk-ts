import { describe, expect, it } from 'vitest';
import { ErrorCode, type FatalReason } from '../src/index.js';
import { conv, flush, msg, setup } from './helpers.js';

const AB = 'c2c:alice:bob';

function status(h: ReturnType<typeof setup>, convId = AB) {
  return h.im
    .messages(convId)
    .map((m) => `${m.clientMsgId}:${m.status}${m.error ? `(${m.error})` : ''}${m.seq ? `#${m.seq}` : ''}`);
}

describe('发送队列与状态机（FE-005、PRD F-MSG-03）', () => {
  it('在线发送：发送中 → 收到 ack 已发送，按 seq 归位；发言即已读', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 4, unread: 4 })]);
    const r = h.im.send(AB, '  你好  ');
    expect(r).toMatchObject({ ok: true, message: { status: 'sending', body: { text: '你好' } } });
    expect(c.last('send').data).toEqual({
      convType: 'c2c',
      to: 'bob',
      clientMsgId: 'cid-0001',
      type: 'text',
      body: { text: '你好' },
    });
    c.ack('send', { msgId: 'm5', convId: AB, seq: 5, ts: 99 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#5']);
    expect(h.im.conversations()[0]).toMatchObject({ maxSeq: 5, readSeq: 5, unread: 0 });
  });

  it('空白和超长不发送', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    expect(h.im.send(AB, ' \n ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(h.im.send(AB, '字'.repeat(5001))).toMatchObject({ ok: false, reason: 'tooLong', over: 1 });
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(0);
  });

  it('10 秒没有 ack 标记失败（AC-MSG-03-1）；ack 晚到时以 ack 为准（C-30）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    h.im.send(AB, 'hi');
    h.clock.advance(9_999);
    expect(status(h)).toEqual(['cid-0001:sending']);
    h.clock.advance(1);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(timeout)']);
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 1 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1']);
  });

  it('错误码透传给界面：4042 / 4290 / 4033（AC-MSG-01-9、AC-MSG-07-2、AC-CONV-03-3）', async () => {
    for (const code of [ErrorCode.USER_NOT_FOUND, ErrorCode.RATE_LIMITED, ErrorCode.NOT_GROUP_MEMBER]) {
      const h = setup();
      h.im.connect('t');
      const c = await h.login();
      h.im.send(AB, 'x');
      c.ackError('send', code);
      await flush();
      expect(status(h)).toEqual([`cid-0001:failed(${code})`]);
    }
  });

  it('离线发送先排队，重连后自动发一次，对方只收到一条（AC-MSG-03-2）', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = await h.login();
    c1.drop(1006);
    h.im.send(AB, 'offline');
    expect(status(h)).toEqual(['cid-0001:queued']);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    const sends = c2.frames().filter((f) => f.cmd === 'send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.data?.clientMsgId).toBe('cid-0001');
    c2.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 1 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1']);
  });

  it('自动补发只做一次：补发后又断线就标记失败', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = await h.login();
    c1.drop(1006);
    h.im.send(AB, 'x');
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    c2.drop(1006);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(timeout)']);
  });

  it('手动重发沿用原 clientMsgId，成功后只有一条（AC-MSG-03-3、AC-MSG-03-4）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    h.im.send(AB, 'retry me');
    h.clock.advance(10_000);
    await flush();
    h.im.retry(AB, 'cid-0001');
    const sends = c.frames().filter((f) => f.cmd === 'send');
    expect(sends.map((f) => f.data?.clientMsgId)).toEqual(['cid-0001', 'cid-0001']);
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 1 }); // 服务端去重，返回第一次的 msgId
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1']);
    expect(h.im.messages(AB)[0]?.msgId).toBe('m1');
  });

  it('removeFailed：只移除失败的消息，pendingCount 减 1，不发帧，之后重发无效（AC-UI-09-5、G-UI-14）', async () => {
    const h = setup();
    const counts: number[] = [];
    h.im.on('pendingCount', (n) => counts.push(n));
    h.im.connect('t');
    const c = await h.login();
    h.im.send(AB, 'sent one');
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 1 });
    await flush();
    h.im.send(AB, 'fails');
    h.clock.advance(10_000);
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1', 'cid-0002:failed(timeout)']);
    expect(h.im.pendingCount()).toBe(1);
    const frames = c.frames().length;

    expect(h.im.removeFailed(AB, 'cid-0001')).toBe(false); // sent 不动
    expect(h.im.removeFailed(AB, 'nope')).toBe(false);
    expect(status(h)).toEqual(['cid-0001:sent#1', 'cid-0002:failed(timeout)']);

    expect(h.im.removeFailed(AB, 'cid-0002')).toBe(true);
    expect(status(h)).toEqual(['cid-0001:sent#1']);
    expect(h.im.pendingCount()).toBe(0);
    expect(counts.at(-1)).toBe(0);
    expect(h.im.removeFailed(AB, 'cid-0002')).toBe(false);
    h.im.retry(AB, 'cid-0002');
    expect(c.frames().length).toBe(frames);
    expect(status(h)).toEqual(['cid-0001:sent#1']);
  });

  it('removeFailed：发送中 / 排队的消息不能移除', async () => {
    const h = setup();
    h.im.connect('t');
    await h.login();
    h.im.send(AB, 'sending');
    expect(h.im.removeFailed(AB, 'cid-0001')).toBe(false);
    expect(status(h)).toEqual(['cid-0001:sending']);
  });

  it('removeFailed 只拦自己发的：别人用同一个 clientMsgId 发的消息照常显示', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    h.im.send(AB, 'mine');
    h.clock.advance(10_000);
    await flush();
    expect(h.im.removeFailed(AB, 'cid-0001')).toBe(true);
    c.receive({ cmd: 'msg', data: { ...msg(AB, 1, 'bob', 'theirs'), clientMsgId: 'cid-0001' } });
    await flush();
    expect(h.im.messages(AB).map((m) => m.body?.text)).toEqual(['theirs']);
  });

  it('removeFailed 之后，晚到的 ack 和 sync 都不能让它再出现（AC-UI-09-5）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    h.im.send(AB, 'timed out');
    h.clock.advance(10_000);
    await flush();
    h.im.removeFailed(AB, 'cid-0001');
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 1 }); // 超时后 ack 才到
    await flush();
    expect(h.im.messages(AB)).toEqual([]);
    c.receive({ cmd: 'msg', data: { ...msg(AB, 1, 'alice', 'timed out'), clientMsgId: 'cid-0001' } });
    await flush();
    expect(h.im.messages(AB)).toEqual([]);
    expect(h.im.pendingCount()).toBe(0);
  });

  it('被踢时发送中和排队的消息全部标记失败（AC-AUTH-03-6）', async () => {
    const h = setup();
    const fatal: FatalReason[] = [];
    h.im.on('fatal', (r) => fatal.push(r));
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.send(AB, 'a');
    h.im.send(AB, 'b');
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4012, 'banned');
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(kicked)', 'cid-0002:failed(kicked)']);
    expect(fatal[0]).toMatchObject({ kind: 'kicked', reason: 'banned' });
  });

  it('未确认的消息排在所有有 seq 的消息之后（F-MSG-03 规则 3）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.send(AB, 'mine');
    c.receive({
      cmd: 'msg',
      data: {
        msgId: 'x',
        clientMsgId: 'b1',
        convId: AB,
        seq: 1,
        from: 'bob',
        type: 'text',
        body: { text: 'hi' },
        ts: 1,
      },
    });
    expect(h.im.messages(AB).map((m) => m.clientMsgId)).toEqual(['b1', 'cid-0001']);
    c.ack('send', { msgId: 'm2', convId: AB, seq: 2, ts: 2 });
    await flush();
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual([1, 2]);
  });
});

describe('被踢时的待发消息', () => {
  it('发给还不在会话列表里的新联系人：也标记失败并发 sendFailed（AC-AUTH-03-6）', async () => {
    const h = setup();
    const failed: string[] = [];
    h.im.on('sendFailed', (convId, id, why) => failed.push(`${convId}/${id}/${why}`));
    h.im.connect('t');
    const c = await h.login('alice', []);
    expect(h.im.send('c2c:alice:carol', 'hi')).toMatchObject({ ok: true });
    expect(h.im.conversations().map((x) => x.convId)).not.toContain('c2c:alice:carol');
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4012, 'banned');
    expect(failed).toEqual(['c2c:alice:carol/cid-0001/kicked']);
    expect(status(h, 'c2c:alice:carol')).toEqual(['cid-0001:failed(kicked)']);
  });
});
