// FE-680（C5）：会话置顶、免打扰、删除、多端同步、总未读（PRD-chat 第 9 节 F-CVS，第 13.1 节）。
// 真实的 IMClient + FakeTransport + 假时钟。测试下发的帧和 SDK 发出的帧都按 frame.schema.json 校验，假数据不会和服务端走样。
// 共享用例 chat-sync.json 的 C5 部分由 BE-487 生成，在 chat-sync-vectors.test.ts 跑；新帧的 Schema 在 frames-schema.test.ts。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorCode, IMError, TimeoutError, type Conversation, type ProcessedImage } from '../src/index.js';
import type { ServerConversation, ServerMessage } from '../src/protocol.js';
import type { FakeConnection } from '../src/testing/index.js';
import { SchemaValidator } from './support/json-schema.js';
import { accountSetup, HOUR, USER } from './support/account.js';
import { conv, flush, msg, setup, type Harness } from './helpers.js';

const schema = new SchemaValidator(
  JSON.parse(readFileSync(new URL('../protocol/schema/frame.schema.json', import.meta.url), 'utf8')),
);

const AB = 'c2c:alice:bob';
const AC = 'c2c:alice:carol';
const G1 = 'group:g1';
const G2 = 'group:g2';
const quiet = { timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } }; // 推进时钟时不因心跳断线

/** 消息 ID 用协议允许的字符。 */
const idOf = (convId: string, seq: number) => `${convId.replace(/[^A-Za-z0-9]/g, '')}-${seq}`;
function m(convId: string, seq: number, from = 'bob', text = `m${seq}`): ServerMessage {
  return { ...msg(convId, seq, from, text), msgId: idOf(convId, seq) };
}
/** 符合 Schema 的会话（群要带 memberCount、myRole、modVer）。 */
function sc(p: Partial<ServerConversation> & { convId: string }): ServerConversation {
  const group = p.convId.startsWith('group:');
  return conv({ modVer: 0, ...(group ? { memberCount: 3, myRole: 'member' } : {}), ...p });
}

/** 服务端下发：先按 Schema 校验。 */
function down(c: FakeConnection, frame: Record<string, unknown>): void {
  expect(schema.errors(frame), JSON.stringify(frame)).toEqual([]);
  c.receive(frame);
}
const event = (c: FakeConnection, data: Record<string, unknown>) => down(c, { cmd: 'event', data });
const ack = (c: FakeConnection, cmd: string, data: Record<string, unknown>) =>
  down(c, { id: c.last(cmd).id, cmd: 'ack', data });
const ackErr = (c: FakeConnection, cmd: string, code: number) =>
  down(c, { id: c.last(cmd).id, cmd: 'ack', error: { code, msg: 'x' } });

/** SDK 发出的帧都符合 Schema。 */
function framesValid(c: FakeConnection): void {
  for (const f of c.frames()) expect(schema.errors(f), f.cmd).toEqual([]);
}

async function online(convs: ServerConversation[], userId = 'alice', opts = quiet): Promise<[Harness, FakeConnection]> {
  const h = setup(opts);
  h.im.connect('t');
  const c = h.transport.current;
  c.open();
  c.ack('auth', { userId, serverTime: h.clock.now() });
  await flush();
  ack(c, 'convs', { convs, truncated: false });
  await flush();
  return [h, c];
}

async function loaded(h: Harness, c: FakeConnection, convId: string, messages: ServerMessage[]): Promise<void> {
  void h.im.loadHistory(convId);
  await flush();
  ack(c, 'sync', { messages, hasMore: false });
  await flush();
}

/** 断线后重连，convs 用给定的应答。 */
async function reconnect(h: Harness, c: FakeConnection, convsAck: Record<string, unknown>): Promise<FakeConnection> {
  c.drop();
  h.clock.advance(60_000);
  await flush();
  const n = h.transport.current;
  n.open();
  n.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
  await flush();
  ack(n, 'convs', convsAck);
  await flush();
  return n;
}

const ids = (h: Harness) => h.im.conversations().map((x) => x.convId);
const find = (h: Harness, convId: string) => h.im.conversations().find((x) => x.convId === convId);

describe('F-CVS-01 置顶', () => {
  it('TC-CVS-01-01（F-CVS-01 规则 3）：置顶的在最前按 pinnedAt 倒序（相同时 updatedAt 倒序、convId 升序），其余 updatedAt 倒序、同时间 convId 升序；引用稳定', async () => {
    const [h] = await online([
      sc({ convId: AB, updatedAt: 300 }),
      sc({ convId: AC, updatedAt: 100 }),
      sc({ convId: G1, updatedAt: 50, pinned: true, pinnedAt: 10 }),
      sc({ convId: G2, updatedAt: 1, pinned: true, pinnedAt: 20 }),
      sc({ convId: 'c2c:alice:dave', updatedAt: 100 }),
      // 置顶时间相同：再按 updatedAt 倒序、convId 升序（Go 参考实现 chatmodel.Conversations）。
      sc({ convId: 'group:g3', updatedAt: 5, pinned: true, pinnedAt: 20 }),
      sc({ convId: 'group:g4', updatedAt: 5, pinned: true, pinnedAt: 20 }),
    ]);
    expect(ids(h)).toEqual(['group:g3', 'group:g4', G2, G1, AB, AC, 'c2c:alice:dave']);
    const a = h.im.conversations();
    expect(h.im.conversations()).toBe(a); // 没有变化时同一个数组（G-UI-19）
  });

  it('TC-CVS-01-01（第 13.1 节）：setConvPinned 发 convSet {convId, pinned}，ack 前本地已移到最前；ack 的 pinnedAt 覆盖本地', async () => {
    const [h, c] = await online([sc({ convId: AB, updatedAt: 300 }), sc({ convId: G1, updatedAt: 100 })]);
    const seen: string[][] = [];
    h.im.on('conversations', (l) => seen.push(l.map((x) => x.convId)));
    const p = h.im.setConvPinned(G1, true);
    expect(c.last('convSet').data).toEqual({ convId: G1, pinned: true });
    expect(ids(h)).toEqual([G1, AB]); // 乐观更新
    expect(find(h, G1)).toMatchObject({ pinned: true, pinnedAt: h.clock.now() });
    expect(seen.at(-1)).toEqual([G1, AB]);
    ack(c, 'convSet', { conv: sc({ convId: G1, updatedAt: 100, pinned: true, pinnedAt: 777 }) });
    await p;
    expect(find(h, G1)).toMatchObject({ pinned: true, pinnedAt: 777 });

    const q = h.im.setConvPinned(G1, false);
    expect(c.last('convSet').data).toEqual({ convId: G1, pinned: false });
    expect(ids(h)).toEqual([AB, G1]);
    expect(find(h, G1)!.pinned).toBeUndefined();
    expect(find(h, G1)!.pinnedAt).toBeUndefined();
    ack(c, 'convSet', { conv: sc({ convId: G1, updatedAt: 100 }) });
    await q;
    expect(ids(h)).toEqual([AB, G1]);
    framesValid(c);
  });

  it('已置顶的再置顶：本地 pinnedAt 不变（服务端同样不变，AC-CVS-01-2）', async () => {
    const [h, c] = await online([sc({ convId: G1, pinned: true, pinnedAt: 55 })]);
    h.clock.advance(10_000);
    const p = h.im.setConvPinned(G1, true);
    expect(find(h, G1)!.pinnedAt).toBe(55);
    ack(c, 'convSet', { conv: sc({ convId: G1, pinned: true, pinnedAt: 55 }) });
    await p;
    expect(find(h, G1)!.pinnedAt).toBe(55);
  });

  for (const code of [5000, ErrorCode.PIN_LIMIT_EXCEEDED, ErrorCode.RATE_LIMITED, 4030]) {
    it(`第 56 条：convSet 失败 ${code}：回滚乐观显示，IMError 交给页面，不自动重试`, async () => {
      const [h, c] = await online([sc({ convId: AB, updatedAt: 300 }), sc({ convId: G1, updatedAt: 100 })]);
      const before = h.im.conversations();
      let total = -1;
      const p = h.im.setConvPinned(G1, true);
      expect(ids(h)).toEqual([G1, AB]);
      h.im.on('conversations', () => (total = h.im.conversations().length));
      ackErr(c, 'convSet', code);
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IMError);
      expect((err as IMError).code).toBe(code);
      expect(ids(h)).toEqual([AB, G1]);
      expect(find(h, G1)!.pinned).toBeUndefined();
      expect(h.im.conversations()).toEqual(before);
      expect(total).toBe(2); // 回滚后发了 conversations
      h.clock.advance(60_000); // 4290 在 errors.json 是可重试：也不自动重试
      await flush();
      expect(c.frames().filter((f) => f.cmd === 'convSet')).toHaveLength(1);
    });
  }

  it('第 56 条：超时、未连接也回滚；免打扰同样', async () => {
    const [h, c] = await online([sc({ convId: AB, unread: 3, maxSeq: 3 })]);
    const p = h.im.setConvNotifyOff(AB, true);
    expect(find(h, AB)!.notifyOff).toBe(true);
    expect(h.im.totalUnread()).toBe(0);
    h.clock.advance(11_000);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
    expect(find(h, AB)!.notifyOff).toBeUndefined();
    expect(h.im.totalUnread()).toBe(3);
    c.drop();
    await flush();
    await expect(h.im.setConvNotifyOff(AB, true)).rejects.toThrow();
    expect(find(h, AB)!.notifyOff).toBeUndefined();
  });

  it('等 ack 期间其他端的 convSettingsChanged 改了同一会话：失败时不回滚成旧值（后到的覆盖，F-CVS-04 异常）', async () => {
    const [h, c] = await online([sc({ convId: G1 })]);
    const p = h.im.setConvPinned(G1, true);
    event(c, { type: 'convSettingsChanged', convId: G1, pinned: true, pinnedAt: 900, notifyOff: true });
    ackErr(c, 'convSet', 5000);
    await expect(p).rejects.toBeInstanceOf(IMError);
    expect(find(h, G1)).toMatchObject({ pinned: true, pinnedAt: 900, notifyOff: true });
  });
});

describe('F-CVS-02 免打扰和总未读（规则 4）', () => {
  it('TC-CVS-02-02（AC-CVS-02-2）：普通未读 2、3，免打扰未读 5：totalUnread()=5，事件同口径；取消免打扰后 10', async () => {
    const [h, c] = await online([
      sc({ convId: AB, maxSeq: 2, unread: 2 }),
      sc({ convId: AC, maxSeq: 3, unread: 3 }),
      sc({ convId: G1, maxSeq: 5, unread: 5, notifyOff: true, mentionUnread: 0 }),
    ]);
    expect(h.im.totalUnread()).toBe(5);
    expect(find(h, G1)).toMatchObject({ notifyOff: true, unread: 5 }); // 未读照常计算（规则 3），列表显示小红点
    const totals: number[] = [];
    h.im.on('totalUnread', (n) => totals.push(n));
    const p = h.im.setConvNotifyOff(G1, false);
    expect(c.last('convSet').data).toEqual({ convId: G1, notifyOff: false });
    expect(h.im.totalUnread()).toBe(10);
    expect(totals).toEqual([10]);
    ack(c, 'convSet', { conv: sc({ convId: G1, maxSeq: 5, unread: 5, mentionUnread: 0 }) });
    await p;
    expect(totals).toEqual([10]);
    // 免打扰会话来了新消息：列表更新、unread 增加，总未读不变（规则 6）。
    const q = h.im.setConvNotifyOff(G1, true);
    ack(c, 'convSet', { conv: sc({ convId: G1, maxSeq: 5, unread: 5, mentionUnread: 0, notifyOff: true }) });
    await q;
    expect(totals).toEqual([10, 5]);
    down(c, { cmd: 'msg', data: m(G1, 6) });
    await flush();
    expect(find(h, G1)!.unread).toBe(6);
    expect(h.im.totalUnread()).toBe(5);
    expect(totals).toEqual([10, 5]);
    framesValid(c);
  });

  it('TC-CVS-02-05（AC-CVS-02-5）：免打扰未读 5 其中 1 条 @ 我、普通未读 2：totalUnread()=3；读到 @ 那条之后 2', async () => {
    const [h, c] = await online([
      sc({ convId: AB, maxSeq: 2, unread: 2 }),
      sc({ convId: G1, maxSeq: 5, unread: 5, notifyOff: true, mentionUnread: 1, firstMentionSeq: 3 }),
    ]);
    expect(h.im.totalUnread()).toBe(3);
    await loaded(
      h,
      c,
      G1,
      [1, 2, 3, 4, 5].map((s) => m(G1, s)),
    );
    h.im.setActiveConversation(G1); // 本端读到最新
    await flush();
    expect(c.last('read').data).toEqual({ convId: G1, seq: 5 });
    expect(h.im.totalUnread()).toBe(2);
  });

  it('免打扰会话实时收到 @ 我：总未读 +1（@ 我计入，R-CF-20）；没开免打扰时口径不变', async () => {
    const [h, c] = await online([
      sc({ convId: G1, maxSeq: 1, unread: 0, readSeq: 1, notifyOff: true, mentionUnread: 0 }),
    ]);
    const at = { ...m(G1, 2), body: { text: '@alice', mentions: { userIds: ['alice'] } } };
    down(c, { cmd: 'msg', data: at });
    down(c, { cmd: 'msg', data: m(G1, 3) });
    await flush();
    expect(find(h, G1)).toMatchObject({ unread: 2, mentionUnread: 1 });
    expect(h.im.totalUnread()).toBe(1);
  });
});

describe('F-CVS-03 删除会话', () => {
  it('第 13.1 节：deleteConv 发 convDelete {convId, upToSeq = 本地看到的最大 seq}；ack 前先从列表消失；成功后清除并发 convDeleted', async () => {
    const [h, c] = await online([
      sc({ convId: AB, maxSeq: 8, unread: 0, readSeq: 8, updatedAt: 9, pinned: true, pinnedAt: 1 }),
      sc({ convId: AC, updatedAt: 1 }),
    ]);
    await loaded(
      h,
      c,
      AB,
      [7, 8].map((s) => m(AB, s, 'bob', `ZXQ-CVS-1 第 ${s} 条`)),
    );
    down(c, { cmd: 'msg', data: m(AB, 10, 'bob', 'ZXQ-CVS-1 第 10 条') }); // 本地看到的比 convs 的 maxSeq 新
    await flush();
    const deleted: string[] = [];
    h.im.on('convDeleted', (id) => deleted.push(id));
    const p = h.im.deleteConv(AB);
    expect(c.last('convDelete').data).toEqual({ convId: AB, upToSeq: 10 });
    expect(ids(h)).toEqual([AC]);
    expect(deleted).toEqual([]); // 成功之前不让页面清草稿
    ack(c, 'convDelete', { clearedSeq: 10 });
    await p;
    expect(ids(h)).toEqual([AC]);
    expect(deleted).toEqual([AB]);
    expect(h.im.messages(AB)).toEqual([]);
    expect(h.im.conversationSnapshot(AB)).toBeUndefined(); // 不是"你已不在该群"
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-1');
    framesValid(c);
  });

  for (const code of [5000, ErrorCode.RATE_LIMITED, 4030]) {
    it(`F-CVS-03 异常、第 56 条：convDelete 失败 ${code}：会话恢复显示、消息不动，IMError 交给页面，不自动重试`, async () => {
      const [h, c] = await online([sc({ convId: AB, maxSeq: 2, updatedAt: 9 }), sc({ convId: AC, updatedAt: 1 })]);
      await loaded(h, c, AB, [m(AB, 1), m(AB, 2)]);
      h.im.send(AB, '失败的');
      h.clock.advance(11_000);
      await flush();
      const deleted: string[] = [];
      h.im.on('convDeleted', (id) => deleted.push(id));
      const p = h.im.deleteConv(AB);
      await flush();
      expect(ids(h)).toEqual([AC]);
      ackErr(c, 'convDelete', code);
      const err = await p.catch((e: unknown) => e);
      expect((err as IMError).code).toBe(code);
      expect(ids(h)).toEqual([AB, AC]);
      expect(h.im.messages(AB).map((x) => [x.seq, x.status])).toEqual([
        [1, 'sent'],
        [2, 'sent'],
        [undefined, 'failed'],
      ]);
      expect(deleted).toEqual([]);
      h.clock.advance(60_000);
      await flush();
      expect(c.frames().filter((f) => f.cmd === 'convDelete')).toHaveLength(1);
    });
  }

  it('upToSeq 取本地看到的最大 seq：之后的 convs 是旧的（maxSeq 比本地小）也按本地的', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 5, readSeq: 5, updatedAt: 1 })]);
    await loaded(h, c, AB, [m(AB, 4), m(AB, 5)]);
    h.clock.advance(31_000);
    const r = h.im.refreshConversations();
    await flush();
    ack(c, 'convs', { convs: [sc({ convId: AB, maxSeq: 3, readSeq: 3, updatedAt: 1 })], truncated: false });
    await r;
    expect(find(h, AB)!.maxSeq).toBe(3);
    void h.im.deleteConv(AB);
    expect(c.last('convDelete').data).toEqual({ convId: AB, upToSeq: 5 });
  });

  it('TC-CVS-03-02（AC-CVS-03-2）：删除后对方再发 1 条：重新出现，未读 1，只有这 1 条，minSeq=11，翻页不发请求', async () => {
    const [h, c] = await online([
      sc({ convId: AB, name: 'Bob', maxSeq: 10, readSeq: 10, unread: 0, updatedAt: 10, notifyOff: true }),
    ]);
    await loaded(
      h,
      c,
      AB,
      [9, 10].map((s) => m(AB, s, 'bob', `ZXQ-CVS-1 ${s}`)),
    );
    const p = h.im.deleteConv(AB);
    ack(c, 'convDelete', { clearedSeq: 10 });
    await p;
    expect(ids(h)).toEqual([]);
    down(c, { cmd: 'msg', data: m(AB, 11, 'bob', '新的一条') });
    await flush();
    expect(find(h, AB)).toMatchObject({ name: 'Bob', unread: 1, minSeq: 11, readSeq: 10, maxSeq: 11, notifyOff: true });
    expect(find(h, AB)!.pinned).toBeUndefined();
    expect(h.im.messages(AB).map((x) => x.seq)).toEqual([11]);
    // 翻页：minSeq 之前没有了，不发请求。
    const n = c.frames().length;
    await expect(h.im.loadHistory(AB)).resolves.toBe(false);
    expect(c.frames().length).toBe(n);
    // 重新出现的是本地临时恢复的条目：稍后拉一次 convs，以服务端为准。
    h.clock.advance(300);
    await flush();
    ack(c, 'convs', {
      convs: [sc({ convId: AB, name: 'Bob', maxSeq: 11, readSeq: 10, unread: 1, minSeq: 11, notifyOff: true })],
      truncated: false,
    });
    await flush();
    expect(find(h, AB)).toMatchObject({ unread: 1, minSeq: 11 });
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-1');
  });

  it('清除之后迟到的 sync 应答（删除前发出的）带着 seq ≤ clearedSeq 的消息：不写进来', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 30, readSeq: 30, updatedAt: 1 })]);
    void h.im.loadHistory(AB); // 请求发出，应答迟到
    await flush();
    const p = h.im.deleteConv(AB);
    c.receive({ id: c.last('convDelete').id, cmd: 'ack', data: { clearedSeq: 30 } });
    await p;
    c.receive({
      id: c.last('sync').id,
      cmd: 'ack',
      data: { messages: [m(AB, 29, 'bob', 'ZXQ-CVS-3')], hasMore: true },
    });
    await flush();
    expect(h.im.messages(AB)).toEqual([]);
    expect(ids(h)).toEqual([]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-3');
  });

  it('第 59 条、AC-CVS-03-8（SDK 部分）：确认删除时取消这个会话正在上传的附件（DELETE 临时对象）、丢弃排队和失败的消息；别的会话不动', async () => {
    const h = accountSetup();
    const ab = `c2c:${USER}:bob`;
    const ac = `c2c:${USER}:carol`;
    h.session(1, 24 * HOUR);
    const c = await h.online();
    const img: ProcessedImage = {
      original: { data: new Uint8Array(1000), mime: 'image/jpeg' },
      thumb: { data: new Uint8Array(100), mime: 'image/jpeg' },
      width: 10,
      height: 10,
    };
    h.im.sendImage(ab, img);
    await flush();
    h.http
      .to('/v1/files/uploads')
      .at(-1)!
      .respond(200, { fileId: 'F1', put: { url: 'https://s3.test/x?X-Amz-Signature=1', headers: {}, expiresAt: 1 } });
    await flush();
    const failed = h.im.send(ab, 'ZXQ-CVS-2 失败的');
    h.clock.advance(11_000); // 10 秒没有 ack：失败
    await flush();
    const other = h.im.send(ac, '别的会话');
    expect(failed.ok && h.im.messages(ab).find((x) => x.clientMsgId === failed.message.clientMsgId)?.status).toBe(
      'failed',
    );
    const p = h.im.deleteConv(ab);
    expect(c.last('convDelete').data).toEqual({ convId: ab, upToSeq: 0 });
    await flush();
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE')).toHaveLength(0); // 取消要等成功
    c.receive({ id: c.last('convDelete').id, cmd: 'ack', data: { clearedSeq: 0 } });
    await p;
    await flush();
    expect(h.im.messages(ab)).toEqual([]);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE').map((x) => x.path)).toEqual(['/v1/files/uploads/F1']);
    expect(h.im.pendingCount()).toBe(1);
    expect(other.ok && h.im.messages(ac).map((x) => x.clientMsgId)).toEqual([other.ok && other.message.clientMsgId]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-2');
  });

  it('F-CVS-03 规则 3、6 ②：被清除的图片、文件经 filesExpired 让页面丢掉 blob 缓存；正在下载的中止（不是撤回）', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 2, readSeq: 2, updatedAt: 1 })]);
    const pic: ServerMessage = {
      ...m(AB, 1),
      type: 'image',
      body: { image: { fileId: 'F9', width: 1, height: 1, size: 1, mime: 'image/png' } },
    };
    await loaded(h, c, AB, [pic, m(AB, 2)]);
    const expired: string[][] = [];
    h.im.on('filesExpired', (f) => expired.push(f));
    const p = h.im.deleteConv(AB);
    ack(c, 'convDelete', { clearedSeq: 2 });
    await p;
    expect(expired).toEqual([['F9']]);
  });

  it('删除到 clearedSeq 小于本地最新（upToSeq 之后到了新消息，规则 5）：会话不消失，只清除 ≤ clearedSeq，未读只算之后的', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 3, readSeq: 3, updatedAt: 1, pinned: true, pinnedAt: 5 })]);
    await loaded(h, c, AB, [m(AB, 1), m(AB, 2), m(AB, 3)]);
    const p = h.im.deleteConv(AB);
    down(c, { cmd: 'msg', data: m(AB, 4) });
    ack(c, 'convDelete', { clearedSeq: 3 });
    await p;
    await flush();
    expect(ids(h)).toEqual([AB]);
    expect(find(h, AB)).toMatchObject({ minSeq: 4, unread: 1 });
    expect(find(h, AB)!.pinned).toBeUndefined();
    expect(h.im.messages(AB).map((x) => x.seq)).toEqual([4]);
  });

  it('TC-CVS-03-05（AC-CVS-03-5）：D2 离线时 D1 删除 g1：重连 convs 里 g1 在 deleted，从列表消失，没有 convRemoved、没有快照，本地消息清除；进入 g1 能发言', async () => {
    const [h, c] = await online([
      sc({ convId: G1, maxSeq: 12, readSeq: 12, updatedAt: 12 }),
      sc({ convId: G2, maxSeq: 1, readSeq: 1, updatedAt: 1 }),
    ]);
    await loaded(h, c, G1, [m(G1, 11, 'bob', 'ZXQ-CVS-1'), m(G1, 12)]);
    const removed: string[] = [];
    h.im.on('convRemoved', (id) => removed.push(id));
    const n = await reconnect(h, c, {
      convs: [sc({ convId: G2, maxSeq: 1, readSeq: 1, updatedAt: 1 })],
      truncated: false,
      deleted: [{ convId: G1, clearedSeq: 12 }],
    });
    expect(ids(h)).toEqual([G2]);
    expect(removed).toEqual([]);
    expect(h.im.conversationSnapshot(G1)).toBeUndefined();
    expect(h.im.messages(G1)).toEqual([]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-1');
    // 从通讯录进入：空的聊天页，可以发送；发出去的这条让会话重新出现。
    const r = h.im.send(G1, '我还在群里');
    expect(r.ok).toBe(true);
    ack(n, 'send', { msgId: 'g1-13', convId: G1, seq: 13, ts: 5000 });
    await flush();
    expect(h.im.messages(G1).map((x) => [x.seq, x.status])).toEqual([[13, 'sent']]);
  });

  it('TC-CVS-03-05 对照：g2 既不在 convs 也不在 deleted，照常推断"你已不在该群"；truncated 或 deletedTruncated 时都不推断（第 54 条）', async () => {
    for (const [flags, want] of [
      [{ truncated: false }, [G2]],
      [{ truncated: true }, []],
      [{ truncated: false, deletedTruncated: true }, []],
    ] as const) {
      const [h, c] = await online([sc({ convId: G1, updatedAt: 2 }), sc({ convId: G2, updatedAt: 1 })]);
      const removed: string[] = [];
      h.im.on('convRemoved', (id) => removed.push(id));
      await reconnect(h, c, { convs: [], deleted: [{ convId: G1, clearedSeq: 0 }], ...flags });
      expect(removed, JSON.stringify(flags)).toEqual(want);
      expect(h.im.conversationSnapshot(G1)).toBeUndefined();
      expect(!!h.im.conversationSnapshot(G2)).toBe(want.length > 0);
    }
  });

  it('F-CVS-03 规则 6 ②：convs 列表里的会话也按 minSeq 物理清除；还没发出的引用了被清除消息的，引用原文清除', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 5, readSeq: 5, updatedAt: 5 })]);
    await loaded(
      h,
      c,
      AB,
      [1, 2, 3, 4, 5].map((s) => m(AB, s, 'bob', `ZXQ-CVS-4 ${s}`)),
    );
    c.drop();
    await flush();
    const r = h.im.send(AB, '回复', { quote: { msgId: idOf(AB, 2) } });
    expect(r.ok && r.message.body.quote).toMatchObject({ state: 'normal', text: 'ZXQ-CVS-4 2' });
    const keep = h.im.send(AB, '回复留下的', { quote: { msgId: idOf(AB, 4) } });
    h.clock.advance(60_000);
    await flush();
    const n = h.transport.current;
    n.open();
    n.ack('auth', { userId: 'alice', serverTime: h.clock.now() });
    await flush();
    ack(n, 'convs', { convs: [sc({ convId: AB, maxSeq: 5, readSeq: 5, minSeq: 4, updatedAt: 5 })], truncated: false });
    await flush();
    expect(
      h.im
        .messages(AB)
        .filter((x) => x.seq)
        .map((x) => x.seq),
    ).toEqual([4, 5]);
    const pending = h.im.messages(AB).find((x) => r.ok && x.clientMsgId === r.message.clientMsgId)!;
    expect(pending.body.quote).toEqual({ msgId: idOf(AB, 2), seq: 2, from: 'bob', type: 'text', state: 'deleted' });
    const kept = h.im.messages(AB).find((x) => keep.ok && x.clientMsgId === keep.message.clientMsgId)!;
    expect(kept.body.quote).toMatchObject({ msgId: idOf(AB, 4), state: 'normal', text: 'ZXQ-CVS-4 4' });
    const dump = JSON.stringify(h.im.debugExport());
    for (const s of [1, 2, 3]) expect(dump).not.toContain(`ZXQ-CVS-4 ${s}`);
  });

  it('P-46 ④：删除之后对方的新消息引用了被清除的旧消息，引用摘要照常显示（服务端组装）', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 2, readSeq: 2, updatedAt: 2 })]);
    await loaded(h, c, AB, [m(AB, 1), m(AB, 2)]);
    const p = h.im.deleteConv(AB);
    ack(c, 'convDelete', { clearedSeq: 2 });
    await p;
    const reply: ServerMessage = {
      ...m(AB, 3),
      body: {
        text: '你看这条',
        quote: { msgId: idOf(AB, 1), seq: 1, from: 'bob', type: 'text', state: 'normal', text: 'm1' },
      },
    };
    down(c, { cmd: 'msg', data: reply });
    await flush();
    expect(h.im.messages(AB).map((x) => x.body.quote?.text)).toEqual(['m1']);
  });

  it('backend-chat 第 85 条：对被删除隐藏的会话 convSet，ack 的 conv 不让它重新出现；有新消息时带着新设置出现', async () => {
    const [h, c] = await online([sc({ convId: AB, maxSeq: 2, readSeq: 2, updatedAt: 2 })]);
    const p = h.im.deleteConv(AB);
    ack(c, 'convDelete', { clearedSeq: 2 });
    await p;
    const q = h.im.setConvNotifyOff(AB, true);
    ack(c, 'convSet', { conv: sc({ convId: AB, maxSeq: 2, readSeq: 2, minSeq: 3, updatedAt: 2, notifyOff: true }) });
    await q;
    expect(ids(h)).toEqual([]);
    down(c, { cmd: 'msg', data: m(AB, 3) });
    await flush();
    expect(find(h, AB)).toMatchObject({ notifyOff: true, unread: 1 });
  });
});

describe('F-CVS-03 规则 6a 重新入群（frontend-chat 第 65 条，AC-CVS-03-12 的客户端侧）', () => {
  /** 删除 g1 到 10（本地下限 11），之后被移出。 */
  async function deletedThenRemoved(): Promise<[Harness, FakeConnection]> {
    const [h, c] = await online([sc({ convId: G1, maxSeq: 10, readSeq: 10, updatedAt: 10 })]);
    await loaded(
      h,
      c,
      G1,
      [9, 10].map((s) => m(G1, s, 'bob', `ZXQ-CVS-8 ${s}`)),
    );
    const p = h.im.deleteConv(G1);
    ack(c, 'convDelete', { clearedSeq: 10 });
    await p;
    expect(h.im.messages(G1)).toEqual([]);
    return [h, c];
  }

  async function olderHistoryLoads(h: Harness, c: FakeConnection): Promise<void> {
    void h.im.loadHistory(G1);
    await flush();
    expect(c.last('sync').data).toMatchObject({ convId: G1, beforeSeq: 11 });
    ack(c, 'sync', { messages: [8, 9, 10].map((s) => m(G1, s, 'bob', `旧历史 ${s}`)), hasMore: true });
    await flush();
    expect(h.im.messages(G1).map((x) => x.seq)).toEqual([8, 9, 10]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-8'); // 之前清除的副本没有回来，回来的是重新拉到的
  }

  it('在线：convRemoved 后 convAdded 的 minSeq=1（historyVisible=true）：下限放低，清除范围里的旧历史可以重新加载', async () => {
    const [h, c] = await deletedThenRemoved();
    event(c, { type: 'convRemoved', convId: G1, reason: 'removed' });
    event(c, {
      type: 'convAdded',
      conv: sc({ convId: G1, maxSeq: 10, readSeq: 10, minSeq: 1, updatedAt: 11 }),
    });
    expect(find(h, G1)).toMatchObject({ minSeq: 1 });
    await olderHistoryLoads(h, c);
  });

  it('离线期间被移出又加入（本地没有快照、没有收到 convRemoved）：重连 convs 的 minSeq 比本地下限小，同样放低', async () => {
    const [h, c] = await deletedThenRemoved();
    const n = await reconnect(h, c, {
      convs: [sc({ convId: G1, maxSeq: 10, readSeq: 10, minSeq: 1, updatedAt: 11 })],
      truncated: false,
    });
    expect(find(h, G1)).toMatchObject({ minSeq: 1 });
    await olderHistoryLoads(h, n);
  });

  it('删除后还留着更新的消息（翻页已到底）：重新入群放低下限后又可以往前翻', async () => {
    const [h, c] = await online([sc({ convId: G1, maxSeq: 10, readSeq: 10, updatedAt: 10 })]);
    await loaded(
      h,
      c,
      G1,
      [9, 10].map((s) => m(G1, s)),
    );
    down(c, { cmd: 'msg', data: m(G1, 11) });
    event(c, { type: 'convDeleted', convId: G1, clearedSeq: 10 });
    await flush();
    expect(h.im.messages(G1).map((x) => x.seq)).toEqual([11]);
    const n = c.frames().length;
    await expect(h.im.loadHistory(G1)).resolves.toBe(false); // 到 minSeq 了，不发请求
    expect(c.frames().length).toBe(n);
    event(c, { type: 'convAdded', conv: sc({ convId: G1, maxSeq: 11, readSeq: 11, minSeq: 1, updatedAt: 11 }) });
    void h.im.loadHistory(G1);
    await flush();
    expect(c.last('sync').data).toMatchObject({ convId: G1, beforeSeq: 11 });
    ack(c, 'sync', { messages: [m(G1, 10)], hasMore: true });
    await flush();
    expect(h.im.messages(G1).map((x) => x.seq)).toEqual([10, 11]);
  });

  it('convAdded 的 minSeq 比已加载的大（重新入群、historyVisible=false）：按它清除', async () => {
    const [h, c] = await online([sc({ convId: G1, maxSeq: 6, readSeq: 6, updatedAt: 6 })]);
    await loaded(
      h,
      c,
      G1,
      [1, 2, 3, 4, 5, 6].map((s) => m(G1, s, 'bob', `ZXQ-CVS-9 ${s}`)),
    );
    event(c, { type: 'convRemoved', convId: G1, reason: 'removed' });
    event(c, { type: 'convAdded', conv: sc({ convId: G1, maxSeq: 6, readSeq: 6, minSeq: 5, updatedAt: 7 }) });
    await flush();
    expect(h.im.messages(G1).map((x) => x.seq)).toEqual([5, 6]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-9 4');
  });

  it('对照：服务端 minSeq 还是 clearedSeq + 1 时下限不动，迟到的旧消息照样不写进来', async () => {
    const [h, c] = await deletedThenRemoved();
    const n = await reconnect(h, c, {
      convs: [sc({ convId: G1, maxSeq: 12, readSeq: 10, unread: 2, minSeq: 11, updatedAt: 12 })],
      truncated: false,
    });
    void h.im.loadHistory(G1);
    await flush();
    ack(n, 'sync', { messages: [9, 10, 11, 12].map((s) => m(G1, s)), hasMore: false });
    await flush();
    expect(h.im.messages(G1).map((x) => x.seq)).toEqual([11, 12]);
  });
});

describe('F-CVS-04 多端同步', () => {
  it('TC-CVS-04-01（AC-CVS-04-1）：另一端置顶、免打扰：convSettingsChanged 覆盖本地，c1 移到最前；取消置顶不留 pinnedAt', async () => {
    const [h, c] = await online([
      sc({ convId: AB, updatedAt: 300, maxSeq: 2, unread: 2 }),
      sc({ convId: G1, updatedAt: 100, maxSeq: 4, unread: 4 }),
    ]);
    const lists: Conversation[][] = [];
    h.im.on('conversations', (l) => lists.push(l));
    event(c, { type: 'convSettingsChanged', convId: G1, pinned: true, pinnedAt: 1234, notifyOff: false });
    expect(ids(h)).toEqual([G1, AB]);
    expect(find(h, G1)).toMatchObject({ pinned: true, pinnedAt: 1234 });
    event(c, { type: 'convSettingsChanged', convId: G1, pinned: true, pinnedAt: 1234, notifyOff: true });
    expect(find(h, G1)!.notifyOff).toBe(true);
    expect(h.im.totalUnread()).toBe(2);
    expect(lists).toHaveLength(2);
    event(c, { type: 'convSettingsChanged', convId: G1, pinned: true, pinnedAt: 1234, notifyOff: true }); // 没有变化
    expect(lists).toHaveLength(2);
    event(c, { type: 'convSettingsChanged', convId: G1, pinned: false, notifyOff: false });
    expect(ids(h)).toEqual([AB, G1]);
    expect(find(h, G1)!.pinnedAt).toBeUndefined();
    expect(find(h, G1)!.notifyOff).toBeUndefined();
    expect(h.im.totalUnread()).toBe(6);
    event(c, { type: 'convSettingsChanged', convId: 'group:zz', pinned: true, pinnedAt: 1, notifyOff: false }); // 不认识的忽略
    expect(ids(h)).toEqual([AB, G1]);
  });

  it('TC-CVS-04-05（AC-CVS-04-5，第 55 条）：另一端删除：convDeleted 后会话消失，本地消息清除，发 convDeleted 让页面清草稿；之后新消息只算新的未读、保留免打扰', async () => {
    const [h, c] = await online([
      sc({ convId: AB, maxSeq: 10, readSeq: 6, unread: 4, updatedAt: 10, pinned: true, pinnedAt: 3, notifyOff: true }),
      sc({ convId: AC, updatedAt: 1 }),
    ]);
    await loaded(
      h,
      c,
      AB,
      [9, 10].map((s) => m(AB, s, 'bob', `ZXQ-CVS-1 ${s}`)),
    );
    const deleted: string[] = [];
    const removed: string[] = [];
    h.im.on('convDeleted', (id) => deleted.push(id));
    h.im.on('convRemoved', (id) => removed.push(id));
    event(c, { type: 'convDeleted', convId: AB, clearedSeq: 10 });
    expect(ids(h)).toEqual([AC]);
    expect(deleted).toEqual([AB]);
    expect(removed).toEqual([]);
    expect(h.im.messages(AB)).toEqual([]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-1');
    down(c, { cmd: 'msg', data: m(AB, 11) });
    await flush();
    expect(find(h, AB)).toMatchObject({ minSeq: 11, readSeq: 10, unread: 1, notifyOff: true });
    expect(find(h, AB)!.pinned).toBeUndefined();
    expect(find(h, AB)!.pinnedAt).toBeUndefined();
  });

  it('convDeleted 空群（clearedSeq=0）：从列表移除；之后有消息重新出现（AC-CVS-03-11 的客户端部分）', async () => {
    const [h, c] = await online([sc({ convId: G1, maxSeq: 0, updatedAt: 5 })]);
    event(c, { type: 'convDeleted', convId: G1, clearedSeq: 0 });
    expect(ids(h)).toEqual([]);
    down(c, { cmd: 'msg', data: m(G1, 1) });
    await flush();
    expect(find(h, G1)).toMatchObject({ unread: 1, minSeq: 1 });
  });

  it('TC-CVS-04-02（AC-CVS-04-2）：D2 离线时 D1 置顶 c1 并删除 c2：D2 重连后顺序、置顶、免打扰和服务端一致，c2 不在列表、本地消息清除', async () => {
    const [h, c] = await online([
      sc({ convId: AB, maxSeq: 2, readSeq: 2, updatedAt: 1 }),
      sc({ convId: AC, maxSeq: 3, readSeq: 3, updatedAt: 9 }),
      sc({ convId: G1, maxSeq: 1, readSeq: 1, updatedAt: 5, notifyOff: true }),
    ]);
    await loaded(h, c, AB, [m(AB, 1), m(AB, 2)]);
    await loaded(h, c, AC, [m(AC, 1, 'carol', 'ZXQ-CVS-5'), m(AC, 2), m(AC, 3)]);
    const server = [
      sc({ convId: AB, maxSeq: 2, readSeq: 2, updatedAt: 1, pinned: true, pinnedAt: 99 }),
      sc({ convId: G1, maxSeq: 1, readSeq: 1, updatedAt: 5, notifyOff: true }),
    ];
    await reconnect(h, c, { convs: server, truncated: false, deleted: [{ convId: AC, clearedSeq: 3 }] });
    expect(
      h.im.conversations().map((x) => [x.convId, x.pinned === true, x.pinnedAt ?? null, x.notifyOff === true]),
    ).toEqual([
      [AB, true, 99, false],
      [G1, false, null, true],
    ]);
    expect(h.im.messages(AC)).toEqual([]);
    expect(h.im.messages(AB).map((x) => x.seq)).toEqual([1, 2]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-CVS-5');
  });

  it('老服务端（convs 没有 pinned、notifyOff、deleted）：口径和 C4 相同', async () => {
    const [h] = await online([
      sc({ convId: AB, updatedAt: 1, maxSeq: 2, unread: 2 }),
      sc({ convId: AC, updatedAt: 2, maxSeq: 1, unread: 1 }),
    ]);
    expect(ids(h)).toEqual([AC, AB]);
    expect(h.im.totalUnread()).toBe(3);
  });
});

describe('features.convSettings（backend-chat 第 75 条，P-46 ②）', () => {
  it('有类型声明：开、关、老服务端没有这个字段都能直接读；关闭时 SDK 照常应用已有的置顶、免打扰、删除', async () => {
    for (const [features, want] of [
      [{ files: true, convSettings: true }, true],
      [{ files: true, convSettings: false }, false],
      [{ files: true }, undefined],
    ] as const) {
      const h = accountSetup();
      const p = h.account.getConfig();
      await flush();
      h.http.last('/v1/config').respond(200, { registerMode: 'open', demoLogin: false, features, limits: {} });
      const on: boolean | undefined = (await p).features.convSettings;
      expect(on).toBe(want);
    }
    // 关闭时服务端照样下发已有设置（只拦新命令）：SDK 不看开关。
    const [h] = await online([
      sc({ convId: AB, updatedAt: 9, maxSeq: 3, unread: 3, notifyOff: true }),
      sc({ convId: AC, updatedAt: 1, pinned: true, pinnedAt: 1 }),
    ]);
    expect(ids(h)).toEqual([AC, AB]);
    expect(h.im.totalUnread()).toBe(0);
  });
});
