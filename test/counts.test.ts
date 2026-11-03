import { describe, expect, it } from 'vitest';
import { conv, flush, msg, setup } from './helpers.js';

const AB = 'c2c:alice:bob';
const AC = 'c2c:alice:carol';
const G = 'group:g1';

describe('未读总数与待发送条数（FE-201、G-UI-15、G-UI-20）', () => {
  it('totalUnread：三个会话 2 + 5 + 0 = 7；新消息 +1；打开会话后减少，变化才发事件（AC-UI-23-1、AC-UI-23-3）', async () => {
    const h = setup();
    const totals: number[] = [];
    h.im.on('totalUnread', (n) => totals.push(n));
    h.im.connect('t');
    const c = await h.login('alice', [
      conv({ convId: AB, maxSeq: 2, unread: 2 }),
      conv({ convId: AC, maxSeq: 5, unread: 5 }),
      conv({ convId: G, type: 'group', maxSeq: 0, unread: 0 }),
    ]);
    expect(h.im.totalUnread()).toBe(7);
    c.receive({ cmd: 'msg', data: msg(AB, 3) });
    await flush();
    expect(h.im.totalUnread()).toBe(8);
    h.im.setActiveConversation(AC);
    expect(h.im.totalUnread()).toBe(3);
    expect(totals).toEqual([7, 8, 3]); // 没有重复的相同值
  });

  it('pendingCount：发送中 1 → 超时失败仍为 1 → 再发一条 2 → 两条都成功后 0；退出登录清零（AC-UI-16-2）', async () => {
    const h = setup();
    const counts: number[] = [];
    h.im.on('pendingCount', (n) => counts.push(n));
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.send(AB, 'one');
    expect(h.im.pendingCount()).toBe(1);
    h.clock.advance(10_000);
    await flush();
    expect(h.im.messages(AB)[0]?.status).toBe('failed');
    expect(h.im.pendingCount()).toBe(1);
    h.im.send(AC, 'two');
    expect(h.im.pendingCount()).toBe(2);
    c.ack('send', { msgId: 'm2', convId: AC, seq: 1, ts: 1 });
    await flush();
    expect(h.im.pendingCount()).toBe(1);
    h.im.retry(AB, 'cid-0001');
    expect(h.im.pendingCount()).toBe(1);
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 2 });
    await flush();
    expect(h.im.pendingCount()).toBe(0);
    expect(counts).toEqual([1, 2, 1, 0]);
    h.im.send(AB, 'three');
    h.im.disconnect();
    expect(h.im.pendingCount()).toBe(0);
  });
});

describe('sendFailed 事件（FE-202、G-UI-22）', () => {
  it('每次失败只发一次：4290 → 重发 → 再次 4290 共两次；超时一次；晚到的 ack 不再发', async () => {
    const h = setup();
    const got: string[] = [];
    h.im.on('sendFailed', (convId, id, err) => got.push(`${convId}/${id}/${err}`));
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.send(AB, 'hi');
    c.ackError('send', 4290);
    await flush();
    h.im.retry(AB, 'cid-0001');
    c.ackError('send', 4290);
    await flush();
    h.im.send(AB, 'later');
    h.clock.advance(10_000);
    await flush();
    c.ack('send', { msgId: 'm2', convId: AB, seq: 1, ts: 1 });
    await flush();
    expect(got).toEqual([`${AB}/cid-0001/4290`, `${AB}/cid-0001/4290`, `${AB}/cid-0002/timeout`]);
  });
});
