import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMError, avatarColorIndex, avatarInitial, fnv1a32 } from '../src/index.js';
import { conv, flush, msg, setup } from './helpers.js';

const AB = 'c2c:alice:bob';
const G = 'group:g1';

describe('会话快照引用稳定（FE-203、G-UI-19、AC-UI-90-7）', () => {
  it('500 个会话推 1 条消息，只有 1 个会话对象换了引用；没有变化时返回同一个数组', async () => {
    const h = setup();
    h.im.connect('t');
    const convs = Array.from({ length: 500 }, (_, i) =>
      conv({ convId: `c2c:alice:u${String(i).padStart(3, '0')}`, updatedAt: i }),
    );
    const c = await h.login('alice', convs);
    const before = h.im.conversations();
    expect(h.im.conversations()).toBe(before);
    c.receive({ cmd: 'msg', data: msg('c2c:alice:u250', 1, 'u250') });
    await flush();
    const after = h.im.conversations();
    const byId = new Map(before.map((x) => [x.convId, x]));
    const changed = after.filter((x) => byId.get(x.convId) !== x).map((x) => x.convId);
    expect(changed).toEqual(['c2c:alice:u250']);
  });
});

describe('memberCount 与 refreshConversations（FE-204、G-UI-02、G-UI-24）', () => {
  it('透传 memberCount，缺失时是 undefined；30 秒内只拉一次 convs；truncated 可读', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, memberCount: 5 }), conv({ convId: 'group:g2' })]);
    expect(h.im.conversations().find((x) => x.convId === G)?.memberCount).toBe(5);
    expect(h.im.conversations().find((x) => x.convId === 'group:g2')?.memberCount).toBeUndefined();
    expect(h.im.truncated()).toBe(false);

    const sent = () => c.frames().filter((f) => f.cmd === 'convs').length;
    const n = sent();
    await h.im.refreshConversations(); // 登录时刚拉过，节流期内不发
    expect(sent()).toBe(n);
    h.clock.advance(29_999);
    await h.im.refreshConversations();
    expect(sent()).toBe(n);
    h.clock.advance(1);
    const p = h.im.refreshConversations();
    expect(sent()).toBe(n + 1);
    c.ack('convs', { convs: [conv({ convId: G, memberCount: 7 }), conv({ convId: 'group:g2' })], truncated: true });
    await p;
    expect(h.im.conversations().find((x) => x.convId === G)?.memberCount).toBe(7);
    expect(h.im.truncated()).toBe(true);
  });
});

describe('被移出群的会话快照（FE-205、G-UI-21）', () => {
  it('在线收到 convRemoved：保留快照和 reason；convAdded 清除快照；退出登录清除', async () => {
    const h = setup();
    const removed: Array<[string, string | undefined]> = [];
    h.im.on('convRemoved', (id, reason) => removed.push([id, reason]));
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, name: '周末球局' })]);
    c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G, reason: 'dissolved' } });
    expect(h.im.conversations()).toEqual([]);
    expect(h.im.conversationSnapshot(G)).toEqual({
      convId: G,
      type: 'group',
      name: '周末球局',
      removed: true,
      reason: 'dissolved',
    });
    expect(removed).toEqual([[G, 'dissolved']]);
    c.receive({ cmd: 'event', data: { type: 'convAdded', conv: conv({ convId: G, name: '周末球局' }) } });
    expect(h.im.conversationSnapshot(G)).toBeUndefined();
    c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: G } });
    expect(h.im.conversationSnapshot(G)?.reason).toBeUndefined();
    h.im.disconnect();
    expect(h.im.conversationSnapshot(G)).toBeUndefined();
  });

  it('离线期间被移出：重连后列表里消失的群生成快照并发 convRemoved；单聊不推断；截断时不推断', async () => {
    const h = setup();
    const removed: string[] = [];
    h.im.on('convRemoved', (id) => removed.push(id));
    h.im.connect('t');
    await h.login('alice', [conv({ convId: G, name: 'g1' }), conv({ convId: AB }), conv({ convId: 'group:g2' })]);
    h.transport.current.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    c2.ack('convs', { convs: [conv({ convId: 'group:g2' })], truncated: false });
    await flush();
    expect(removed).toEqual([G]);
    expect(h.im.conversationSnapshot(G)).toMatchObject({ name: 'g1', removed: true });
    expect(h.im.conversationSnapshot(AB)).toBeUndefined();

    // 截断的列表里缺少的群可能只是被挤出了前 500 个，不能当成被移出。
    c2.drop(1006);
    h.clock.advance(2_000);
    const c3 = h.transport.current;
    c3.open();
    c3.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    c3.ack('convs', { convs: [], truncated: true });
    await flush();
    expect(removed).toEqual([G]);
    expect(h.im.conversationSnapshot('group:g2')).toBeUndefined();
  });
});

describe('打开本地没有的会话（FE-206、G-UI-26）', () => {
  it('发 sync beforeSeq = MAX_SAFE_INTEGER；4033 / 4043 以 IMError 交给界面', async () => {
    for (const code of [4033, 4043, 4032]) {
      const h = setup();
      h.im.connect('t');
      const c = await h.login('alice', []);
      const p = h.im.loadHistory(G);
      expect(c.last('sync').data).toEqual({ convId: G, beforeSeq: Number.MAX_SAFE_INTEGER, limit: 20 });
      c.ackError('sync', code);
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IMError);
      expect((err as IMError).code).toBe(code);
    }
  });

  it('有历史时把消息和会话补进列表；单聊没有消息时保持临时会话', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', []);
    const p = h.im.loadHistory(G);
    c.ack('sync', { messages: [msg(G, 1), msg(G, 2)], hasMore: false });
    expect(await p).toBe(false);
    expect(h.im.messages(G).map((m) => m.seq)).toEqual([1, 2]);
    expect(h.im.conversations().map((x) => x.convId)).toEqual([G]);

    const q = h.im.loadHistory(AB);
    c.ack('sync', { messages: [], hasMore: false });
    expect(await q).toBe(false);
    expect(h.im.conversations().map((x) => x.convId)).toEqual([G]);
  });
});

describe('占位头像：与其他 SDK 共用 protocol/vectors/avatar.json（FE-210、AC-UI-21-1、AC-UI-21-2）', () => {
  const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/avatar.json', import.meta.url), 'utf8')) as {
    colors: { id: string; fnv1a32: number; index: number }[];
    initials: { name: string; initial: string }[];
  };
  it('颜色下标', () => {
    for (const c of spec.colors) {
      expect(fnv1a32(c.id), c.id).toBe(c.fnv1a32);
      expect(avatarColorIndex(c.id), c.id).toBe(c.index);
    }
  });
  it('首字', () => {
    for (const c of spec.initials) expect(avatarInitial(c.name), c.name).toBe(c.initial);
  });
});
