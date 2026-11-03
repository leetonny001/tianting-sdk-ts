import { describe, expect, it } from 'vitest';
import { conv, flush, msg, setup } from './helpers.js';

const AB = 'c2c:alice:bob';

describe('同步引擎（FE-004）', () => {
  it('缺口：收到 1、3，500ms 内 2 没到就 sync，最终按 1、2、3 展示（AC-MSG-04-3）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 0 })]);
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    c.receive({ cmd: 'msg', data: msg(AB, 3) });
    h.clock.advance(499);
    expect(c.frames().filter((f) => f.cmd === 'sync')).toHaveLength(0);
    h.clock.advance(1);
    expect(c.last('sync').data).toEqual({ convId: AB, afterSeq: 1, limit: 200 });
    c.ack('sync', { messages: [msg(AB, 2), msg(AB, 3)], hasMore: false });
    await flush();
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('缺口在 500ms 内补上就不 sync（AC-MSG-04-4）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    c.receive({ cmd: 'msg', data: msg(AB, 3) });
    h.clock.advance(200);
    c.receive({ cmd: 'msg', data: msg(AB, 2) });
    h.clock.advance(1_000);
    expect(c.frames().filter((f) => f.cmd === 'sync')).toHaveLength(0);
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('按 msgId 去重：同一条消息收到两次只出现一次（F-MSG-04 规则 1）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB })]);
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    c.receive({ cmd: 'msg', data: msg(AB, 1) });
    expect(h.im.messages(AB)).toHaveLength(1);
    expect(h.im.conversations()[0]?.unread).toBe(1);
  });

  it('重连：先 convs，再只补拉落后的、本地加载过的会话；断线期间的 3 条按序无重复（AC-CONN-01-4、TC-CONN-01-08）', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = await h.login('alice', [conv({ convId: AB }), conv({ convId: 'c2c:alice:carol' })]);
    c1.receive({ cmd: 'msg', data: msg(AB, 1) });
    c1.receive({ cmd: 'msg', data: msg(AB, 2) });
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    c2.ack('convs', {
      convs: [conv({ convId: AB, maxSeq: 5, unread: 3 }), conv({ convId: 'c2c:alice:carol', maxSeq: 9, unread: 9 })],
      truncated: false,
    });
    await flush();
    const syncs = c2.frames().filter((f) => f.cmd === 'sync');
    expect(syncs.map((f) => f.data)).toEqual([{ convId: AB, afterSeq: 2, limit: 200 }]); // carol 的会话没加载过，不补拉
    c2.ack('sync', { messages: [msg(AB, 2), msg(AB, 3), msg(AB, 4), msg(AB, 5)], hasMore: false });
    await flush();
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('群补拉起点为 max(本地 maxSeq, minSeq − 1)（C-24、TC-CONN-01-21）', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = await h.login('alice', [conv({ convId: 'group:g1', maxSeq: 3 })]);
    c1.receive({ cmd: 'msg', data: msg('group:g1', 3) });
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    // 断线期间被移出又重新加入：minSeq 变成 11
    c2.ack('convs', { convs: [conv({ convId: 'group:g1', maxSeq: 12, minSeq: 11, unread: 2 })], truncated: false });
    await flush();
    expect(c2.last('sync').data).toEqual({ convId: 'group:g1', afterSeq: 10, limit: 200 });
  });

  it('缺口超过 200 条：只加载最新 20 条，向上翻页能加载到全部（AC-CONN-01-8）', async () => {
    const h = setup();
    h.im.connect('t');
    const c1 = await h.login('alice', [conv({ convId: AB })]);
    c1.receive({ cmd: 'msg', data: msg(AB, 1) });
    c1.drop(1006);
    h.clock.advance(1_000);
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: 1 });
    await flush();
    c2.ack('convs', { convs: [conv({ convId: AB, maxSeq: 251, unread: 250 })], truncated: false });
    await flush();
    expect(c2.last('sync').data).toEqual({ convId: AB, beforeSeq: 252, limit: 20 });
    c2.ack('sync', { messages: Array.from({ length: 20 }, (_, i) => msg(AB, 232 + i)), hasMore: true });
    await flush();
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => 232 + i));

    const more = h.im.loadHistory(AB);
    await flush();
    expect(c2.last('sync').data).toEqual({ convId: AB, beforeSeq: 232, limit: 20 });
    c2.ack('sync', { messages: Array.from({ length: 20 }, (_, i) => msg(AB, 212 + i)), hasMore: true });
    expect(await more).toBe(true);
    expect(h.im.messages(AB)[0]?.seq).toBe(212);
  });

  it('打开会话 loadHistory：首次 beforeSeq = maxSeq + 1，hasMore=false 后不再请求（F-MSG-05）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 3, unread: 3 })]);
    const p = h.im.loadHistory(AB);
    await flush();
    expect(c.last('sync').data).toEqual({ convId: AB, beforeSeq: 4, limit: 20 });
    c.ack('sync', { messages: [msg(AB, 1), msg(AB, 2), msg(AB, 3)], hasMore: false });
    expect(await p).toBe(false);
    const n = c.frames().length;
    expect(await h.im.loadHistory(AB)).toBe(false);
    expect(c.frames()).toHaveLength(n);
  });

  it('convAdded / convRemoved 更新会话列表（F-GRP-03、AC-CONN-01-7）', async () => {
    const h = setup();
    const removed: string[] = [];
    h.im.on('convRemoved', (id) => removed.push(id));
    h.im.connect('t');
    const c = await h.login('alice');
    c.receive({
      cmd: 'event',
      data: { type: 'convAdded', conv: conv({ convId: 'group:g1', name: '新群', updatedAt: 5 }) },
    });
    expect(h.im.conversations().map((x) => x.name)).toEqual(['新群']);
    c.receive({ cmd: 'event', data: { type: 'convRemoved', convId: 'group:g1' } });
    expect(h.im.conversations()).toEqual([]);
    expect(removed).toEqual(['group:g1']);
  });

  it('会话按 updatedAt 倒序、convId 升序；新消息把会话移到最前（AC-CONV-01-2、AC-CONV-01-4）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [
      conv({ convId: 'group:gB', updatedAt: 100 }),
      conv({ convId: 'c2c:alice:bob', updatedAt: 100 }),
      conv({ convId: 'group:ga', updatedAt: 50 }),
    ]);
    expect(h.im.conversations().map((x) => x.convId)).toEqual(['c2c:alice:bob', 'group:gB', 'group:ga']);
    c.receive({ cmd: 'msg', data: { ...msg('group:ga', 1, 'carol', '最新'), ts: 200 } });
    const first = h.im.conversations()[0];
    expect(first?.convId).toBe('group:ga');
    expect(first?.lastMsg).toMatchObject({ text: '最新', from: 'carol', ts: 200 });
  });

  it('别人第一次发来单聊：本地补一个会话，name 为对方', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice');
    c.receive({ cmd: 'msg', data: msg('c2c:alice:zed', 1, 'zed') });
    expect(h.im.conversations()[0]).toMatchObject({ convId: 'c2c:alice:zed', name: 'zed', unread: 1 });
  });

  it('自己在其他端发的消息不增加未读，并推进已读（C-34、AC-SYNC-01-2）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 2, unread: 2 })]);
    c.receive({ cmd: 'msg', data: msg(AB, 3, 'alice') });
    expect(h.im.conversations()[0]).toMatchObject({ unread: 0, readSeq: 3 });
  });
});

describe('临时会话', () => {
  it('第一次收到某个会话的消息：先补临时会话，200ms 后重新拉 convs，用服务端数据替换（昵称等）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice');
    const convsBefore = c.frames().filter((f) => f.cmd === 'convs').length;
    c.receive({ cmd: 'msg', data: msg('c2c:alice:zed', 1, 'zed') });
    c.receive({ cmd: 'msg', data: msg('c2c:alice:zed', 2, 'zed') });
    expect(h.im.conversations()[0]?.name).toBe('zed');
    h.clock.advance(200);
    expect(c.frames().filter((f) => f.cmd === 'convs')).toHaveLength(convsBefore + 1); // 合并为一次
    c.ack('convs', {
      convs: [conv({ convId: 'c2c:alice:zed', name: '小泽', maxSeq: 2, unread: 2 })],
      truncated: false,
    });
    await flush();
    expect(h.im.conversations()[0]).toMatchObject({ name: '小泽', unread: 2 });
    c.receive({ cmd: 'msg', data: msg('c2c:alice:zed', 3, 'zed') });
    h.clock.advance(1_000);
    expect(c.frames().filter((f) => f.cmd === 'convs')).toHaveLength(convsBefore + 1); // 已知会话不再刷新
  });
});
