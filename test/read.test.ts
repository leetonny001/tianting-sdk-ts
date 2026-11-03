import { describe, expect, it } from 'vitest';
import { conv, flush, msg, setup } from './helpers.js';

const AB = 'c2c:alice:bob';

describe('已读上报与未读数（FE-006、PRD F-CONV-02）', () => {
  it('停在会话且页面可见时上报最新 seq，本地立即清零（AC-CONV-02-2）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 3, unread: 3 })]);
    expect(h.im.conversations()[0]?.unread).toBe(3);
    h.im.setActiveConversation(AB);
    expect(c.last('read').data).toEqual({ convId: AB, seq: 3 });
    expect(h.im.conversations()[0]).toMatchObject({ unread: 0, readSeq: 3 });
  });

  it('页面在后台不上报，未读增加；切回前台后上报并清零（AC-CONV-02-7）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.visible.value = false;
    h.im.setActiveConversation(AB);
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    c.receive({ cmd: 'msg', data: msg(AB, 2) });
    expect(c.frames().filter((f) => f.cmd === 'read')).toHaveLength(0);
    expect(h.im.conversations()[0]?.unread).toBe(2);
    h.visible.value = true;
    h.im.visibilityChanged();
    expect(c.last('read').data).toEqual({ convId: AB, seq: 2 });
    expect(h.im.conversations()[0]?.unread).toBe(0);
  });

  it('节流：1 秒内最多上报一次，值为最新 seq（TC-CONV-02-03）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.setActiveConversation(AB);
    for (let s = 1; s <= 5; s++) {
      c.receive({ cmd: 'msg', data: msg(AB, s) });
      h.clock.advance(100);
    }
    const reads = () =>
      c
        .frames()
        .filter((f) => f.cmd === 'read')
        .map((f) => f.data?.seq);
    expect(reads()).toEqual([1]);
    h.clock.advance(600); // 距第一次上报满 1 秒
    expect(reads()).toEqual([1, 5]);
  });

  it('不在会话里（列表页）不上报', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    h.im.setActiveConversation(null);
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    expect(c.frames().filter((f) => f.cmd === 'read')).toHaveLength(0);
  });

  it('未读从入群时刻算起：已读低于 joinSeq 不会让未读变多（C-02、TC-CONV-02-09）', async () => {
    const h = setup();
    h.im.connect('t');
    // 服务端：maxSeq=15、joinSeq=10、readSeq=0 → unread=5
    const c = await h.login('alice', [conv({ convId: 'group:g1', maxSeq: 15, minSeq: 11, unread: 5 })]);
    c.receive({ cmd: 'event', data: { type: 'readUpdated', convId: 'group:g1', readSeq: 3 } });
    expect(h.im.conversations()[0]?.unread).toBe(5);
    c.receive({ cmd: 'event', data: { type: 'readUpdated', convId: 'group:g1', readSeq: 13 } });
    expect(h.im.conversations()[0]?.unread).toBe(2);
    c.receive({ cmd: 'msg', data: msg('group:g1', 16) });
    expect(h.im.conversations()[0]?.unread).toBe(3);
  });

  it('readUpdated 只进不退（AC-SYNC-02-1 客户端部分）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 10, unread: 10 })]);
    c.receive({ cmd: 'event', data: { type: 'readUpdated', convId: AB, readSeq: 8 } });
    c.receive({ cmd: 'event', data: { type: 'readUpdated', convId: AB, readSeq: 5 } });
    expect(h.im.conversations()[0]).toMatchObject({ readSeq: 8, unread: 2 });
    await flush();
  });
});
