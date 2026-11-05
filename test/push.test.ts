// pushes 流里共享用例没有覆盖的部分：字段、未知 cmd、自动补拉不被 convs 阻塞、业务异常、日志。
import { describe, expect, it } from 'vitest';
import type { Push } from '../src/index.js';
import { flush, setup } from './helpers.js';

const SECRET = 'ZXQ-PUSH-SECRET-777';
const frame = (extra: Record<string, unknown> = {}) => ({
  cmd: 'push',
  data: { pushId: 'p1', type: 'notice', data: { text: SECRET }, ts: 2_000_000_000_000, target: 'user', ...extra },
});

async function authed(h: ReturnType<typeof setup>, userId = 'alice') {
  h.im.connect('tok-SECRET-123');
  await flush();
  const c = h.transport.current;
  c.open();
  c.ack('auth', { userId, serverTime: h.clock.now() });
  await flush();
  return c;
}

const syncs = (c: { frames(): Array<{ cmd: string; data?: unknown }> }) =>
  c
    .frames()
    .filter((f) => f.cmd === 'pushSync')
    .map((f) => f.data);

describe('pushes 流', () => {
  it('AC-PUSH-03-7：有订阅者时 auth 成功自动发一次 pushSync，limit 固定 100', async () => {
    const h = setup();
    h.im.on('push', () => {});
    const c = await authed(h);
    expect(syncs(c)).toEqual([{ afterSeq: 0, limit: 100 }]);
  });

  it('AC-PUSH-03-25：没有订阅者时一次都不发，通用监听器不算订阅者', async () => {
    const h = setup();
    h.im.on('conversations', () => {});
    h.im.on('pushSynced', () => {});
    const c = await authed(h);
    c.receive(frame({ pushSeq: 1 }));
    h.clock.advance(60_000);
    await flush();
    expect(syncs(c)).toEqual([]);
    expect(h.im.pushCursor()).toBe(0);
  });

  it('AC-PUSH-03-24：convs 不回也照常补拉和交付；pushSync 失败不影响 convs', async () => {
    const h = setup();
    const got: Push[] = [];
    h.im.on('push', (p) => got.push(p));
    const c = await authed(h);
    expect(c.frames().map((f) => f.cmd)).toContain('convs');
    c.ack('pushSync', {
      pushes: [{ pushId: 'p1', pushSeq: 1, type: 'notice', data: {}, ts: h.clock.now(), target: 'user' }],
      hasMore: false,
      latestSeq: 1,
    });
    await flush();
    expect(got.map((p) => p.pushId)).toEqual(['p1']);

    const h2 = setup();
    h2.im.on('push', () => {});
    const c2 = await authed(h2);
    c2.ackError('pushSync', 5000);
    await flush();
    c2.ack('convs', { convs: [], truncated: false });
    await flush();
    expect(h2.im.conversations()).toEqual([]);
    expect(h2.im.state).toBe('connected');
  });

  it('AC-PUSH-01-3：帧里有未知字段时正常交付，字段不外漏', async () => {
    const h = setup();
    const got: Push[] = [];
    h.im.on('push', (p) => got.push(p));
    const c = await authed(h);
    c.receive(frame({ foo: 'bar', target: 'all' }));
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({
      pushId: 'p1',
      type: 'notice',
      data: { text: SECRET },
      ts: 2_000_000_000_000,
      target: 'all',
      replayed: false,
    });
  });

  it('AC-PUSH-01-5：不认识的顶层 cmd 忽略，连接保持', async () => {
    const h = setup();
    const c = await authed(h);
    c.receive({ cmd: 'futureThing', data: { a: 1 } });
    expect(h.im.state).toBe('connected');
    expect(c.closedWith).toBeNull();
  });

  it('不合法的帧丢弃，不影响后面的帧', async () => {
    const h = setup();
    const got: Push[] = [];
    h.im.on('push', (p) => got.push(p));
    const c = await authed(h);
    c.receive({ cmd: 'push', data: { pushId: 1 } });
    c.receive({ cmd: 'push' });
    c.receive(frame({ pushSeq: 'x' }));
    c.receive(frame({ pushId: 'ok', target: 'all' }));
    expect(got.map((p) => p.pushId)).toEqual(['ok']);
  });

  it('AC-PUSH-08-2：业务回调抛异常不影响下一条和其他订阅者', async () => {
    const h = setup();
    const a: string[] = [];
    const b: string[] = [];
    h.im.on('push', (p) => {
      a.push(p.pushId);
      throw new Error('boom');
    });
    h.im.on('push', (p) => b.push(p.pushId));
    const c = await authed(h);
    c.receive(frame({ pushId: 'x1', target: 'all' }));
    c.receive(frame({ pushId: 'x2', target: 'all' }));
    expect(a).toEqual(['x1', 'x2']);
    expect(b).toEqual(['x1', 'x2']);
  });

  it('AC-PUSH-08-3：日志里没有 data 和 token，包括错误路径和业务异常', async () => {
    const h = setup();
    h.im.on('push', () => {
      throw new Error('boom');
    });
    const c = await authed(h);
    c.receive(frame({ pushSeq: 9 }));
    h.clock.advance(500);
    await flush();
    c.ackError('pushSync', 5000, SECRET.slice(0, 0));
    await flush();
    h.clock.advance(5000);
    await flush();
    c.receive({ cmd: 'push', data: { pushId: 1, data: { text: SECRET } } });
    c.ack('pushSync', { pushes: [{ pushId: 2, data: { text: SECRET } }], hasMore: false, latestSeq: 9 });
    await flush();
    expect(h.logs.length).toBeGreaterThan(0);
    const all = h.logs.join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('tok-SECRET-123');
    expect(c.url).not.toContain('tok-SECRET-123');
  });

  it('真实的 10 秒请求超时算失败，1 秒后重试', async () => {
    const h = setup();
    h.im.on('push', () => {});
    const c = await authed(h);
    expect(syncs(c)).toHaveLength(1);
    h.clock.advance(10_000);
    await flush();
    h.clock.advance(999);
    await flush();
    expect(syncs(c)).toHaveLength(1);
    h.clock.advance(1);
    await flush();
    expect(syncs(c)).toHaveLength(2);
  });

  it('不合法的 ack 按失败退避，不动游标', async () => {
    const h = setup();
    h.im.on('push', () => {});
    const c = await authed(h);
    c.ack('pushSync', { pushes: 'x', hasMore: false, latestSeq: 3 });
    await flush();
    expect(h.im.pushCursor()).toBe(0);
    h.clock.advance(1000);
    await flush();
    expect(syncs(c)).toHaveLength(2);
  });

  it('hasMore=true 但没有进展（页内序号都不大于 afterSeq）：按失败退避，不原地循环', async () => {
    const h = setup();
    h.im.on('push', () => {});
    const c = await authed(h);
    c.ack('pushSync', { pushes: [], hasMore: false, latestSeq: 5 });
    await flush();
    c.drop(1006);
    await flush();
    h.im.networkOnline();
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    await flush();
    c2.ack('pushSync', {
      pushes: [{ pushId: 'old', pushSeq: 5, type: 'notice', data: {}, ts: 1, target: 'user' }],
      hasMore: true,
      latestSeq: 9,
    });
    await flush();
    expect(syncs(c2)).toHaveLength(1);
    h.clock.advance(1000);
    await flush();
    expect(syncs(c2)).toHaveLength(2);
  });

  it('订阅者属于实例：disconnect 之后再登录仍然有效，游标和 T0 都换新', async () => {
    const h = setup();
    const got: Push[] = [];
    h.im.on('push', (p) => got.push(p));
    const c = await authed(h);
    c.ack('pushSync', { pushes: [], hasMore: false, latestSeq: 3 });
    await flush();
    expect(h.im.pushCursor()).toBe(3);
    h.im.disconnect();
    expect(h.im.pushCursor()).toBeNull();
    const c2 = await authed(h, 'bob');
    expect(syncs(c2)).toEqual([{ afterSeq: 0, limit: 100 }]);
  });
});
