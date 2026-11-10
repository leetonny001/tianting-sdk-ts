// FE-660（C4）：撤回、引用、提及（PRD-chat 第 8 节 F-RCL、F-QUO、F-MEN，第 13.1 节）。
// 真实的 IMClient + FakeTransport + 假时钟。共享用例在 chat-sync-vectors.test.ts，帧的 Schema 在 frames-schema.test.ts。
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  IMError,
  messageFor,
  quoteLabel,
  quoteSummary,
  recallNoticeOf,
  recallText,
  type Message,
} from '../src/index.js';
import type { ServerMessage } from '../src/protocol.js';
import type { FakeConnection } from '../src/testing/index.js';
import { conv, flush, msg, setup, type Harness } from './helpers.js';

const AB = 'c2c:alice:bob';
const G = 'group:g1';

/** 消息 ID 用协议允许的字符（Schema 的 msgId 不允许 ":" 和 "#"）。 */
function m(convId: string, seq: number, from = 'bob', text = `m${seq}`, extra: Partial<ServerMessage> = {}) {
  return { ...msg(convId, seq, from, text), msgId: `${convId.replace(/[^A-Za-z0-9]/g, '')}-${seq}`, ...extra };
}
const idOf = (convId: string, seq: number) => `${convId.replace(/[^A-Za-z0-9]/g, '')}-${seq}`;
/** 会话列表里的最后一条就是 seq 这条（convs 带的摘要）。 */
const lastOf = (convId: string, seq: number, from: string, text: string) => ({
  lastMsg: { msgId: idOf(convId, seq), from, type: 'text', text, ts: 1000 + seq },
});
const quiet = { timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } }; // 推进时钟时不因心跳断线

async function loaded(h: Harness, c: FakeConnection, convId: string, messages: ServerMessage[]): Promise<void> {
  void h.im.loadHistory(convId);
  await flush();
  c.ack('sync', { messages, hasMore: false });
  await flush();
}

function event(c: FakeConnection, data: Record<string, unknown>): void {
  c.receive({ cmd: 'event', data });
}

const bySeq = (h: Harness, convId: string, seq: number) => h.im.messages(convId).find((x) => x.seq === seq)!;

describe('撤回（F-RCL-01～03）', () => {
  it('TC-RCL-01-01（AC-RCL-01-1）：recall 发出 {convId, msgId}，ack 后本端立即变撤回；对方和自己另一端收到带 recalled 的 msgDeleted', async () => {
    // 操作者：ack 之后本地清除（服务端不给发起的连接发 msgDeleted）。
    const a = setup();
    a.im.connect('t');
    const ca = await a.login('alice', [conv({ convId: AB, maxSeq: 1, ...lastOf(AB, 1, 'alice', 'ZXQ-RCL-2 原文') })]);
    await loaded(a, ca, AB, [m(AB, 1, 'alice', 'ZXQ-RCL-2 原文')]);
    const p = a.im.recall(AB, idOf(AB, 1));
    expect(ca.last('recall').data).toEqual({ convId: AB, msgId: idOf(AB, 1) });
    ca.ack('recall', {});
    await p;
    await flush();
    expect(bySeq(a, AB, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'alice', body: {} });
    expect(a.im.recallText(AB, bySeq(a, AB, 1))).toBe('你撤回了一条消息');
    expect(a.im.conversations()[0]!.lastMsg).toMatchObject({ deleted: true, recalled: true, recalledBy: 'alice' });
    expect(a.im.recallText(AB, a.im.conversations()[0]!.lastMsg!)).toBe('你撤回了一条消息');
    expect(JSON.stringify(a.im.debugExport())).not.toContain('ZXQ-RCL-2');

    // 对方（bob）和 alice 的另一端：msgDeleted 带 recalled。
    for (const [self, want] of [
      ['bob', '对方撤回了一条消息'],
      ['alice', '你撤回了一条消息'],
    ] as const) {
      const h = setup();
      h.im.connect('t');
      const c = await h.login(self, [conv({ convId: AB, maxSeq: 1 })]);
      await loaded(h, c, AB, [m(AB, 1, 'alice', 'ZXQ-RCL-2 原文')]);
      event(c, { type: 'msgDeleted', convId: AB, msgIds: [idOf(AB, 1)], seqs: [1], recalled: { by: 'alice', at: 5 } });
      await flush();
      expect(bySeq(h, AB, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'alice', recalledAt: 5 });
      expect(h.im.recallText(AB, bySeq(h, AB, 1)), self).toBe(want);
      expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-2');
    }
  });

  it('TC-RCL-01-08（AC-RCL-01-8）：canRecall 按 ts 和 auth ack 校正后的服务端时间（设备快 10 分钟），边界 120 秒；菜单打开期间过期点了提示 4097', async () => {
    const h = setup(quiet);
    h.im.connect('t');
    const c = h.transport.current;
    c.open();
    const server = h.clock.now() - 600_000; // 设备时钟比服务端快 10 分钟
    c.ack('auth', { userId: 'alice', serverTime: server });
    await flush();
    c.ack('convs', { convs: [conv({ convId: AB, maxSeq: 3 })], truncated: false });
    await flush();
    await loaded(h, c, AB, [
      m(AB, 1, 'alice', '60 秒前', { ts: server - 60_000 }),
      m(AB, 2, 'alice', '121 秒前', { ts: server - 121_000 }),
      m(AB, 3, 'alice', '恰好 120 秒', { ts: server - 120_000 }),
    ]);
    expect(h.im.canRecall(bySeq(h, AB, 1))).toBe(true);
    expect(h.im.canRecall(bySeq(h, AB, 2))).toBe(false);
    expect(h.im.canRecall(bySeq(h, AB, 3))).toBe(true);
    expect(h.im.messageActions(bySeq(h, AB, 1))).toEqual(['copy', 'quote', 'recall']);
    expect(h.im.messageActions(bySeq(h, AB, 2))).toEqual(['copy', 'quote']);

    // 菜单开着过了 70 秒：点"撤回"由服务端判断，4097 带 windowSeconds，消息不变，不自动重试。
    h.clock.advance(70_000);
    expect(h.im.canRecall(bySeq(h, AB, 1))).toBe(false);
    const p = h.im.recall(AB, idOf(AB, 1));
    c.receive({
      id: c.last('recall').id,
      cmd: 'ack',
      error: { code: 4097, msg: 'recall window expired', details: { windowSeconds: 120 } },
    });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IMError);
    expect(err).toMatchObject({ code: ErrorCode.RECALL_WINDOW_EXPIRED, details: { windowSeconds: 120 } });
    const ws = (err as IMError).details!['windowSeconds'] as number;
    expect(messageFor('recall', 4097, { windowSeconds: ws })).toBe('发送时间超过 2 分钟，无法撤回');
    expect(messageFor('recall', 4097, { windowSeconds: 604_800 })).toBe('发送时间超过 7 天，无法撤回');
    h.clock.advance(60_000);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'recall')).toHaveLength(1);
    expect(bySeq(h, AB, 1)).toMatchObject({ body: { text: '60 秒前' } });
    expect(bySeq(h, AB, 1).deleted).toBeUndefined();
  });

  it('TC-RCL-01-08（F-RCL-02 规则 1、1b）：群里的时限和角色：群主 7 天内任何人的；管理员 7 天内别人的、自己的也是 7 天；成员只有自己的 2 分钟', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 5, myRole: 'member' })]);
    const now = h.clock.now();
    await loaded(h, c, G, [
      m(G, 1, 'bob', '别人 6 天前', { ts: now - 6 * 86_400_000 }),
      m(G, 2, 'bob', '别人 8 天前', { ts: now - 8 * 86_400_000 }),
      m(G, 3, 'alice', '自己 1 天前', { ts: now - 86_400_000 }),
      m(G, 4, 'alice', '自己 60 秒前', { ts: now - 60_000 }),
      {
        ...m(G, 5, '', '', { ts: now - 1_000 }),
        type: 'tip',
        body: { tip: { kind: 'created', actor: 'bob', targets: [], text: '' } },
      },
    ]);
    const can = (role: 'owner' | 'admin' | 'member') =>
      [1, 2, 3, 4, 5].map((s) => h.im.canRecall(bySeq(h, G, s), role));
    expect(can('owner')).toEqual([true, false, true, true, false]);
    expect(can('admin')).toEqual([true, false, true, true, false]); // 对方是管理员时服务端回 4030（规则 1b）
    expect(can('member')).toEqual([false, false, false, true, false]);
    // 不传角色时用会话列表里的 myRole。
    expect([1, 4].map((s) => h.im.canRecall(bySeq(h, G, s)))).toEqual([false, true]);
    expect(h.im.messageActions(bySeq(h, G, 5))).toEqual([]); // 提示行没有菜单
  });

  it('AC-RCL-02-5：管理员撤回其他管理员的消息，服务端 4030，提示"你没有权限撤回这条消息"，消息不变', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 1, myRole: 'admin' })]);
    await loaded(h, c, G, [m(G, 1, 'bob', '管理员 bob 的消息', { ts: h.clock.now() - 1_000 })]);
    expect(h.im.messageActions(bySeq(h, G, 1))).toContain('recall');
    const p = h.im.recall(G, idOf(G, 1));
    c.ackError('recall', ErrorCode.FORBIDDEN);
    const err = (await p.catch((e: unknown) => e)) as IMError;
    expect(err.code).toBe(4030);
    expect(messageFor('recall', err.code)).toBe('你没有权限撤回这条消息');
    expect(bySeq(h, G, 1).body.text).toBe('管理员 bob 的消息');
  });

  it('TC-RCL-02-04（AC-RCL-02-4）：a 撤回 m 的最后一条：a、m、n 的聊天页和列表摘要按规则 1a 第 3 行一致', async () => {
    const names: Record<string, string> = { a: '阿管', m: '小明', n: '小牛' };
    const want: Record<string, string> = {
      a: '你撤回了 小明 的一条消息',
      m: '阿管撤回了你的一条消息',
      n: '阿管撤回了一条成员消息',
    };
    for (const self of ['a', 'm', 'n']) {
      const h = setup();
      h.im.connect('t');
      const c = await h.login(self, [
        conv({
          convId: G,
          maxSeq: 1,
          myRole: self === 'a' ? 'admin' : 'member',
          ...lastOf(G, 1, 'm', 'ZXQ-RCL-2 成员的消息'),
        }),
      ]);
      // 显示名来自成员资料（备注只在本地显示，问题 19）。
      const pm = h.im.loadGroupMembers('g1');
      c.ack('groupMembers', {
        members: Object.entries(names).map(([userId, nickname]) => ({
          userId,
          nickname,
          role: 'member',
          joinedAt: 1,
          avatar: '',
          official: false,
        })),
        nextCursor: '',
      });
      await pm;
      await loaded(h, c, G, [m(G, 1, 'm', 'ZXQ-RCL-2 成员的消息', { ts: h.clock.now() - 1_000 })]);
      if (self === 'a') {
        const p = h.im.recall(G, idOf(G, 1));
        c.ack('recall', {});
        await p;
      } else {
        event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1], recalled: { by: 'a', at: 9 } });
      }
      await flush();
      const last = h.im.conversations()[0]!.lastMsg!;
      expect(last).toMatchObject({ deleted: true, recalled: true, recalledBy: 'a' });
      expect(last.text).toBeUndefined();
      expect(h.im.recallText(G, bySeq(h, G, 1)), self).toBe(want[self]);
      expect(h.im.recallText(G, last), `${self} 列表`).toBe(want[self]);
      expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-2');
    }
  });

  it('TC-RCL-03-01（AC-RCL-03-1）：收到带 recalled 的 msgDeleted 后导出内存搜不到原文；图片撤回通过 filesExpired 丢缓存', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 2 })]);
    const img: ServerMessage = {
      ...m(AB, 2),
      type: 'image',
      body: { image: { fileId: 'f-zxq', width: 1, height: 1, size: 1, mime: 'image/png' } },
    };
    await loaded(h, c, AB, [m(AB, 1, 'bob', 'ZXQ-RCL-2 原文'), img]);
    const expired: string[][] = [];
    h.im.on('filesExpired', (ids) => expired.push(ids));
    event(c, {
      type: 'msgDeleted',
      convId: AB,
      msgIds: [idOf(AB, 1), idOf(AB, 2)],
      seqs: [1, 2],
      recalled: { by: 'bob', at: 7 },
    });
    await flush();
    const dump = JSON.stringify(h.im.debugExport());
    expect(dump).not.toContain('ZXQ-RCL-2');
    expect(dump).not.toContain('f-zxq');
    expect(h.im.messages(AB).map((x) => [x.seq, x.deleted, x.recalled, x.body])).toEqual([
      [1, true, true, {}],
      [2, true, true, {}],
    ]);
    expect(expired).toEqual([['f-zxq']]);
    // 未读不变、会话不重新排序（F-RCL-01 规则 6）。
    expect(h.im.conversations()[0]).toMatchObject({ updatedAt: 0, unread: 0 });
  });

  it('TC-RCL-03-03、TC-RCL-03-11（AC-RCL-03-3、03-11）：断网期间被撤回，重连只对 modVer 变了的 c1 重拉，消息变撤回文案', async () => {
    const h = setup();
    const [c1, c2, c3] = ['c2c:alice:bob', 'c2c:alice:carol', 'c2c:alice:dave'];
    h.im.connect('t');
    let c = await h.login('alice', [
      conv({ convId: c1, maxSeq: 1, modVer: 1 }),
      conv({ convId: c2, maxSeq: 1, modVer: 1 }),
      conv({ convId: c3, maxSeq: 1, modVer: 1 }),
    ]);
    for (const id of [c1, c2, c3]) await loaded(h, c, id, [m(id, 1, id.split(':')[2], 'ZXQ-RCL-2 原文')]);
    c.drop(1006);
    await flush();
    h.clock.advance(1_000);
    await flush();
    c = await h.login('alice', [
      conv({ convId: c1, maxSeq: 1, modVer: 2 }),
      conv({ convId: c2, maxSeq: 1, modVer: 1 }),
      conv({ convId: c3, maxSeq: 1, modVer: 1 }),
    ]);
    const syncs = c.frames().filter((f) => f.cmd === 'sync');
    expect(syncs.map((f) => f.data!['convId'])).toEqual([c1]);
    c.ack('sync', {
      messages: [
        { ...m(c1, 1, 'bob'), body: undefined, deleted: true, recalled: true, recalledAt: 3, recalledBy: 'bob' },
      ],
      hasMore: false,
    });
    await flush();
    expect(bySeq(h, c1, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'bob' });
    expect(h.im.recallText(c1, bySeq(h, c1, 1))).toBe('对方撤回了一条消息');
    expect(JSON.stringify(h.im.messages(c1))).not.toContain('ZXQ-RCL-2');
    expect(c.frames().filter((f) => f.cmd === 'sync')).toHaveLength(1);
  });

  it('问题 32（F-RCL-03 规则 4）：错过了 msgDeleted，convs 的 lastMsg 带 recalled：已加载的那条直接按撤回清（和 sdk-kotlin 一致），只能从假变真', async () => {
    const h = setup();
    const [c1, c2] = ['c2c:alice:bob', 'c2c:alice:carol'];
    h.im.connect('t');
    let c = await h.login('alice', [
      conv({ convId: c1, maxSeq: 1, modVer: 1 }),
      conv({ convId: c2, maxSeq: 1, modVer: 1 }),
    ]);
    await loaded(h, c, c1, [m(c1, 1, 'bob', 'ZXQ-RCL-2 原文')]);
    await loaded(h, c, c2, [m(c2, 1, 'carol', 'ZXQ-RCL-3 原文')]);
    const reconnect = async (lastMsgs: Record<string, unknown>[]) => {
      c.drop(1006);
      await flush();
      h.clock.advance(1_000);
      await flush();
      // modVer 没变（不重拉）：摘要是唯一的线索
      c = await h.login('alice', [
        conv({ convId: c1, maxSeq: 1, modVer: 1, lastMsg: lastMsgs[0] as never }),
        conv({ convId: c2, maxSeq: 1, modVer: 1, lastMsg: lastMsgs[1] as never }),
      ]);
      await flush();
    };
    const gone = (convId: string, from: string, extra = {}) => ({
      msgId: idOf(convId, 1),
      from,
      type: 'text',
      ts: 1001,
      deleted: true,
      ...extra,
    });
    // c1 撤回；c2 后台删除
    await reconnect([gone(c1, 'bob', { recalled: true, recalledBy: 'bob' }), gone(c2, 'carol')]);
    expect(c.frames().filter((f) => f.cmd === 'sync')).toHaveLength(0);
    expect(bySeq(h, c1, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'bob', body: {} });
    expect(h.im.recallText(c1, bySeq(h, c1, 1))).toBe('对方撤回了一条消息');
    expect(bySeq(h, c2, 1)).toMatchObject({ deleted: true, body: {} });
    expect(bySeq(h, c2, 1).recalled).toBeUndefined();
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-');
    // 下一份 convs：c1 只带 deleted（老服务端）不会改回"已删除"；c2 补上 recalled，从后台删除变成撤回
    await reconnect([gone(c1, 'bob'), gone(c2, 'carol', { recalled: true, recalledBy: 'carol' })]);
    expect(bySeq(h, c1, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'bob' });
    expect(bySeq(h, c2, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'carol' });
    expect(h.im.recallText(c2, bySeq(h, c2, 1))).toBe('对方撤回了一条消息');
  });

  it('TC-RCL-03-06（AC-RCL-03-6）：群里 u1 撤回自己的最后一条：u1 列表"你撤回了一条消息"，其他成员"{u1 显示名}撤回了一条消息"', async () => {
    for (const [self, want] of [
      ['u1', '你撤回了一条消息'],
      ['n', 'u1撤回了一条消息'],
    ] as const) {
      const h = setup();
      h.im.connect('t');
      // 列表来自 convs（还没打开过这个群）：lastMsg 带 recalled、recalledBy。
      await h.login(self, [
        conv({
          convId: G,
          maxSeq: 4,
          lastMsg: { msgId: 'x4', from: 'u1', type: 'text', ts: 4, deleted: true, recalled: true, recalledBy: 'u1' },
        }),
      ]);
      const last = h.im.conversations()[0]!.lastMsg!;
      expect(h.im.recallText(G, last), self).toBe(want);
    }
  });

  it('TC-RCL-03-10（AC-RCL-03-10）：单聊撤回，对方"对方撤回了一条消息"、自己"你撤回了一条消息"；提示行菜单为空', () => {
    const recalled = { from: 'u1', recalled: true, recalledBy: 'u1' };
    expect(recallText(recallNoticeOf('c2c:u1:u2', recalled, 'u2')!, (u) => u)).toBe('对方撤回了一条消息');
    expect(recallText(recallNoticeOf('c2c:u1:u2', recalled, 'u1')!, (u) => u)).toBe('你撤回了一条消息');
    // 后台删除不是撤回：没有撤回文案（显示"该消息已被删除"）。
    expect(recallNoticeOf('c2c:u1:u2', { from: 'u1', deleted: true } as Message, 'u2')).toBeNull();
    const h = setup();
    const line: Message = {
      clientMsgId: 'x',
      msgId: 'x',
      seq: 1,
      convId: 'c2c:u1:u2',
      from: 'u1',
      type: 'text',
      body: {},
      ts: h.clock.now(),
      status: 'sent',
      deleted: true,
      recalled: true,
      recalledBy: 'u1',
    };
    expect(h.im.messageActions(line)).toEqual([]);
    expect(h.im.canRecall(line)).toBe(false);
  });

  it('TC-RCL-03-13（AC-RCL-03-13）：m1 本地已撤回，迟到的旧应答带 m1 原文和（之前没加载过的）m2 的 quote.state=normal：都不恢复', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 2 })]);
    await loaded(h, c, G, [m(G, 1, 'bob', 'ZXQ-RCL-2 原文')]);
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1], recalled: { by: 'bob', at: 3 } });
    await flush();
    // 迟到的旧 sync（撤回之前读的库）。
    const p = h.im.loadHistory(G);
    void p;
    const late = [
      m(G, 1, 'bob', 'ZXQ-RCL-2 原文'),
      m(G, 2, 'carol', '回复', {
        body: {
          text: '回复',
          quote: { msgId: idOf(G, 1), seq: 1, from: 'bob', type: 'text', state: 'normal', text: 'ZXQ-RCL-2 原文' },
        },
      }),
    ];
    await flush();
    c.ack('sync', { messages: late, hasMore: false });
    await flush();
    for (const x of late) {
      c.receive({ cmd: 'msg', data: x }); // 同样的内容也可能从实时通道迟到
    }
    await flush();
    expect(bySeq(h, G, 1)).toMatchObject({ deleted: true, recalled: true, body: {} });
    expect(bySeq(h, G, 2).body.quote).toEqual({
      msgId: idOf(G, 1),
      seq: 1,
      from: 'bob',
      type: 'text',
      state: 'recalled',
    });
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-2');
  });

  it('F-RCL-03 规则 2a：后台删除的消息之后才知道是撤回（recalled 从假变真）；已知撤回的不会被后台删除改回去', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 2 })]);
    await loaded(h, c, G, [m(G, 1), m(G, 2)]);
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1] });
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 2)], seqs: [2], recalled: { by: 'bob', at: 3 } });
    await flush();
    expect(h.im.messages(G).map((x) => [x.deleted, x.recalled ?? false])).toEqual([
      [true, false],
      [true, true],
    ]);
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1], recalled: { by: 'bob', at: 4 } });
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 2)], seqs: [2] });
    await flush();
    expect(h.im.messages(G).map((x) => [x.deleted, x.recalled ?? false, x.recalledBy])).toEqual([
      [true, true, 'bob'],
      [true, true, 'bob'],
    ]);
  });

  it('F-RCL-03 规则 2a：sync 里才知道是撤回（本地按后台删除清过）：补上 recalled、recalledBy，正文不回来；之后的旧应答也不回写', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 1, ...lastOf(G, 1, 'bob', 'ZXQ-RCL-2') })]);
    await loaded(h, c, G, [m(G, 1, 'bob', 'ZXQ-RCL-2')]);
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1] });
    await flush();
    // 服务端的撤回状态（重拉或实时通道迟到的同一条），之后再来一份更旧的原文。
    c.receive({
      cmd: 'msg',
      data: { ...m(G, 1, 'bob'), body: undefined, deleted: true, recalled: true, recalledAt: 9, recalledBy: 'bob' },
    });
    c.receive({ cmd: 'msg', data: m(G, 1, 'bob', 'ZXQ-RCL-2') });
    await flush();
    expect(bySeq(h, G, 1)).toMatchObject({ deleted: true, recalled: true, recalledBy: 'bob', recalledAt: 9, body: {} });
    expect(h.im.conversations()[0]!.lastMsg).toMatchObject({ deleted: true, recalled: true, recalledBy: 'bob' });
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-2');
  });
});

describe('引用（F-QUO-01、02）', () => {
  it('TC-QUO-01-01（AC-QUO-01-1）：send 带 quote 上行只发 msgId；本地待发的气泡先有引用条；对方收到 state=normal 和原文摘要', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: AB, maxSeq: 1 })]);
    const long = '长'.repeat(150);
    await loaded(h, c, AB, [m(AB, 1, 'bob', long)]);
    const r = h.im.send(AB, '回复你', { quote: { msgId: idOf(AB, 1) } });
    if (!r.ok) throw new Error('send');
    expect(c.last('send').data['body']).toEqual({ text: '回复你', quote: { msgId: idOf(AB, 1) } });
    const pending = h.im.messages(AB).at(-1)!;
    expect(pending.body.quote).toEqual({
      msgId: idOf(AB, 1),
      seq: 1,
      from: 'bob',
      type: 'text',
      state: 'normal',
      text: '长'.repeat(100), // 前 100 个码点（F-QUO-02 规则 2）
    });
    c.ack('send', { msgId: 'mine-2', convId: AB, seq: 2, ts: 5 });
    await flush();
    expect(bySeq(h, AB, 2)).toMatchObject({ status: 'sent', body: { quote: { state: 'normal' } } });

    // 对方收到的 msg 带 quote（服务端组装），引用条显示摘要。
    const b = setup();
    b.im.connect('t');
    const cb = await b.login('bob', [conv({ convId: AB, maxSeq: 1 })]);
    await loaded(b, cb, AB, [m(AB, 1, 'bob', long)]);
    const q = {
      msgId: idOf(AB, 1),
      seq: 1,
      from: 'bob',
      type: 'text' as const,
      state: 'normal',
      text: '长'.repeat(100),
    };
    cb.receive({ cmd: 'msg', data: m(AB, 2, 'alice', '回复你', { body: { text: '回复你', quote: q } }) });
    await flush();
    expect(bySeq(b, AB, 2).body.quote).toEqual(q);
    expect(quoteLabel(bySeq(b, AB, 2).body.quote!)).toBe('长'.repeat(100));
  });

  it('F-QUO-02 规则 2、3：摘要（图片、文件、带引用的只取自身文字）和四种状态的显示文字', () => {
    expect(quoteSummary({ type: 'image', body: { image: { fileId: 'f' } } })).toBe('[图片]');
    expect(quoteSummary({ type: 'file', body: { file: { fileId: 'f', name: 'a.pdf' } } })).toBe('[文件] a.pdf');
    expect(
      quoteSummary({
        type: 'text',
        body: { text: '自己的话', quote: { msgId: 'x', state: 'normal', text: '更早的' } },
      }),
    ).toBe('自己的话');
    expect(quoteLabel({ msgId: 'x', state: 'recalled' })).toBe('引用内容已被撤回');
    expect(quoteLabel({ msgId: 'x', state: 'deleted' })).toBe('引用内容已被删除');
    expect(quoteLabel({ msgId: 'x', state: 'expired', type: 'image' })).toBe('[图片] 已过期');
    expect(quoteLabel({ msgId: 'x', state: 'expired', type: 'file' })).toBe('[文件] 已过期');
    expect(quoteLabel({ msgId: 'x', state: 'hidden' })).toBe('引用内容不可用');
    // 摘要含 HTML 时原样作为纯文本返回，由页面按文本渲染（AC-QUO-02-5）。
    expect(quoteLabel({ msgId: 'x', state: 'normal', text: '<img src=x onerror=alert(1)>' })).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('TC-QUO-02-02（AC-QUO-02-2）：收到 m1 的 msgDeleted（带 recalled）：已收到的 m2 和待发的 m3 的引用都清除原文，显示"引用内容已被撤回"', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 2 })]);
    const quote = {
      msgId: idOf(G, 1),
      seq: 1,
      from: 'bob',
      type: 'text' as const,
      state: 'normal',
      text: 'ZXQ-QUO-1 原文',
    };
    await loaded(h, c, G, [
      m(G, 1, 'bob', 'ZXQ-QUO-1 原文'),
      m(G, 2, 'carol', '回复', { body: { text: '回复', quote } }),
    ]);
    c.drop(1006); // 待发：排队中的 m3 也引用 m1
    await flush();
    h.im.send(G, '我也回复', { quote: { msgId: idOf(G, 1) } });
    expect(h.im.messages(G).at(-1)!.body.quote?.text).toBe('ZXQ-QUO-1 原文');
    h.clock.advance(1_000);
    await flush();
    const c2 = h.transport.current;
    c2.open();
    c2.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    await flush();
    event(c2, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1], recalled: { by: 'bob', at: 3 } });
    await flush();
    const q2 = bySeq(h, G, 2).body.quote!;
    expect(q2).toEqual({ msgId: idOf(G, 1), seq: 1, from: 'bob', type: 'text', state: 'recalled' });
    expect(quoteLabel(q2)).toBe('引用内容已被撤回');
    expect(h.im.messages(G).at(-1)!.body.quote).toMatchObject({ state: 'recalled' });
    expect(h.im.messages(G).at(-1)!.body.quote?.text).toBeUndefined();
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-QUO-1');
  });

  it('F-QUO-02 规则 4：被引用的消息被后台删除（msgDeleted 不带 recalled）：引用 state=deleted，"引用内容已被删除"', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 2 })]);
    const quote = { msgId: idOf(G, 1), seq: 1, from: 'bob', type: 'text' as const, state: 'normal', text: 'ZXQ-QUO-1' };
    await loaded(h, c, G, [m(G, 1, 'bob', 'ZXQ-QUO-1'), m(G, 2, 'carol', '回复', { body: { text: '回复', quote } })]);
    event(c, { type: 'msgDeleted', convId: G, msgIds: [idOf(G, 1)], seqs: [1] });
    await flush();
    expect(quoteLabel(bySeq(h, G, 2).body.quote!)).toBe('引用内容已被删除');
    expect(bySeq(h, G, 1).recalled).toBeUndefined();
  });

  it('发送带引用失败 4040（reason=quoteUnavailable）：标记失败，带 errorReason，不自动重发；日志里没有引用文字和 @ 的内容', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [conv({ convId: G, maxSeq: 1 })]);
    await loaded(h, c, G, [m(G, 1, 'bob', 'ZXQ-QUO-1 原文')]);
    const r = h.im.send(G, '@小王 ZXQ-MEN-NAME', { quote: { msgId: idOf(G, 1) }, mentions: { userIds: ['wang'] } });
    if (!r.ok) throw new Error('send');
    c.receive({
      id: c.last('send').id,
      cmd: 'ack',
      error: { code: 4040, msg: 'quote unavailable', reason: 'quoteUnavailable' },
    });
    await flush();
    expect(h.im.messages(G).at(-1)).toMatchObject({ status: 'failed', error: 4040, errorReason: 'quoteUnavailable' });
    h.clock.advance(30_000);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'send')).toHaveLength(1);
    const logs = h.logs.join('\n');
    expect(logs).not.toContain('ZXQ-QUO-1');
    expect(logs).not.toContain('ZXQ-MEN-NAME');
    expect(logs).not.toContain('小王');
  });
});

describe('提及（F-MEN-01～03）', () => {
  it('TC-MEN-01-01（AC-MEN-01-1）：u1 @ u2：上行带 mentions（去重）；u2 收到后会话 mentionUnread 加 1、firstMentionSeq；u3 不变', async () => {
    const u1 = setup();
    u1.im.connect('t');
    const c1 = await u1.login('u1', [conv({ convId: G, maxSeq: 4, mentionUnread: 0 })]);
    const r = u1.im.send(G, '@小王 看一下', { mentions: { userIds: ['u2', 'u2', ''] } });
    if (!r.ok) throw new Error('send');
    expect(c1.last('send').data['body']).toEqual({ text: '@小王 看一下', mentions: { userIds: ['u2'] } });
    c1.ack('send', { msgId: 'g1-5', convId: G, seq: 5, ts: 5 });
    await flush();
    expect(u1.im.conversations()[0]!.mentionUnread).toBe(0); // 自己发的不算
    // 自己另一端发的 @ 所有人也不算（F-MEN-03 规则 6）。
    c1.receive({ cmd: 'msg', data: m(G, 6, 'u1', '@所有人', { body: { text: '@所有人', mentions: { all: true } } }) });
    await flush();
    expect(u1.im.conversations()[0]!.mentionUnread).toBe(0);

    const incoming = m(G, 5, 'u1', '@小王 看一下', { body: { text: '@小王 看一下', mentions: { userIds: ['u2'] } } });
    for (const [self, n, first] of [
      ['u2', 1, 5],
      ['u3', 0, undefined],
    ] as const) {
      const h = setup();
      h.im.connect('t');
      const c = await h.login(self, [conv({ convId: G, maxSeq: 4, readSeq: 4, mentionUnread: 0 })]);
      c.receive({ cmd: 'msg', data: incoming });
      await flush();
      expect(h.im.messages(G).at(-1)!.body.mentions).toEqual({ userIds: ['u2'] });
      expect(h.im.conversations()[0]!.mentionUnread, self).toBe(n);
      expect(h.im.conversations()[0]!.firstMentionSeq, self).toBe(first);
    }

    // @ 所有人也算；在这个会话里读到最新后清零（跳转按钮消失）。
    const h = setup();
    h.im.connect('t');
    const c = await h.login('u3', [conv({ convId: G, maxSeq: 4, readSeq: 4, mentionUnread: 0 })]);
    c.receive({ cmd: 'msg', data: m(G, 6, 'o', '@所有人', { body: { text: '@所有人', mentions: { all: true } } }) });
    await flush();
    expect(h.im.conversations()[0]).toMatchObject({ mentionUnread: 1, firstMentionSeq: 6 });
    h.im.setActiveConversation(G);
    await flush();
    expect(c.last('read').data).toEqual({ convId: G, seq: 6 });
    expect(h.im.conversations()[0]!.mentionUnread).toBe(0);
    expect(h.im.conversations()[0]!.firstMentionSeq).toBeUndefined();
  });

  it('F-MEN-01 规则 1：单聊带 mentions 在入队前抛错；mentions 全空时不带', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice');
    expect(() => h.im.send(AB, '@bob', { mentions: { userIds: ['bob'] } })).toThrow(/group/);
    expect(h.im.messages(AB)).toEqual([]);
    h.im.send(G, '纯文本', { mentions: { userIds: [], all: false } });
    expect(c.last('send').data['body']).toEqual({ text: '纯文本' });
  });

  it('TC-MEN-02-05（AC-MEN-02-5）：@ 所有人返回 4293：消息失败、提示"@所有人次数已用完"，断线重连后不自动重发', async () => {
    const h = setup(quiet);
    h.im.connect('t');
    const c = await h.login('o', [conv({ convId: G, maxSeq: 1, myRole: 'owner' })]);
    const failed: number[] = [];
    h.im.on('sendFailed', (_c, _id, e) => failed.push(e as number));
    h.im.send(G, '@所有人 开会', { mentions: { all: true } });
    expect(c.last('send').data['body']).toEqual({ text: '@所有人 开会', mentions: { all: true } });
    c.receive({
      id: c.last('send').id,
      cmd: 'ack',
      error: { code: 4293, msg: 'mention all limited', details: { retryAfterSeconds: 600 } },
    });
    await flush();
    const mine = h.im.messages(G).at(-1)!;
    expect(mine).toMatchObject({ status: 'failed', error: ErrorCode.MENTION_ALL_LIMITED });
    expect(failed).toEqual([4293]);
    expect(messageFor('send', mine.error as number)).toBe('@所有人次数已用完');
    c.drop(1006);
    await flush();
    h.clock.advance(1_000);
    await flush();
    const c2 = await h.login('o', [conv({ convId: G, maxSeq: 1, myRole: 'owner' })]);
    h.clock.advance(60_000);
    await flush();
    expect(c2.frames().filter((f) => f.cmd === 'send')).toHaveLength(0);
    expect(h.im.messages(G).at(-1)).toMatchObject({ status: 'failed', error: 4293 });
  });

  it('TC-MEN-03-07（AC-MEN-03-7）补充：没有提及（mentionUnread=0 或服务端没给）的会话收到 readUpdated、msgDeleted 不拉 convs；断线时不拉', async () => {
    const h = setup(quiet);
    h.im.connect('t');
    const c = await h.login('alice', [
      conv({ convId: G, maxSeq: 9, mentionUnread: 0 }),
      conv({ convId: 'group:g2', maxSeq: 9 }),
      conv({ convId: 'group:g3', maxSeq: 9, mentionUnread: 1, firstMentionSeq: 9 }),
    ]);
    const convs = () => c.frames().filter((f) => f.cmd === 'convs').length;
    const before = convs();
    event(c, { type: 'readUpdated', convId: G, readSeq: 9 });
    event(c, { type: 'msgDeleted', convId: 'group:g2', msgIds: ['x'], seqs: [3] });
    await flush();
    h.clock.advance(10_000);
    await flush();
    expect(convs()).toBe(before);
    // 有提及：窗口内的第二个事件推迟到窗口结束；那时断线了就不拉（重连的 convs 带最新计数）。
    event(c, { type: 'readUpdated', convId: 'group:g3', readSeq: 9 });
    await flush();
    expect(convs()).toBe(before + 1);
    event(c, { type: 'readUpdated', convId: 'group:g3', readSeq: 9 });
    c.drop(1006);
    await flush();
    h.clock.advance(5_000);
    await flush();
    expect(convs()).toBe(before + 1);
  });

  it('F-MEN-01 规则 6：searchGroupMembers 带 keyword（空串不带），资料进缓存；4290 抛给页面、不自动重试', async () => {
    const h = setup(quiet);
    h.im.connect('t');
    const c = await h.login('alice');
    const p = h.im.searchGroupMembers('g1', 'zh');
    expect(c.last('groupMembers').data).toEqual({ groupId: 'g1', keyword: 'zh' });
    c.ack('groupMembers', {
      members: [{ userId: 'zhang', nickname: '张三', role: 'member', joinedAt: 1, avatar: '', official: false }],
      nextCursor: '',
    });
    expect((await p).members.map((x) => x.userId)).toEqual(['zhang']);
    expect(h.im.displayName('zhang')).toBe('张三');
    const p2 = h.im.searchGroupMembers('g1', '', 'cur');
    expect(c.last('groupMembers').data).toEqual({ groupId: 'g1', cursor: 'cur' });
    c.ack('groupMembers', { members: [], nextCursor: '' });
    await p2;
    const p3 = h.im.searchGroupMembers('g1', 'z');
    c.ackError('groupMembers', ErrorCode.RATE_LIMITED);
    await expect(p3).rejects.toMatchObject({ code: 4290 });
    h.clock.advance(5_000);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'groupMembers')).toHaveLength(3);
  });
});
