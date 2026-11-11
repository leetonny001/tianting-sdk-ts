// FE-690（C6）：举报、4510 的处理、features.moderation（PRD-chat 第 10 节 F-MOD-02、F-MOD-03，第 13.1 节）。
// 真实的 IMClient + FakeTransport + 假时钟。测试下发的帧和 SDK 发出的帧都按 frame.schema.json 校验。
// 只用特征串（ZXQ-MOD-*、ZXQ-RPT-*），没有真实敏感词。frames.json 的 C6 用例在 frames-schema.test.ts。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountError,
  ErrorCode,
  IMError,
  NotConnectedError,
  REPORT_NOTE_MAX,
  TimeoutError,
  messageFor,
  type Message,
  type ReportInput,
} from '../src/index.js';
import type { FakeConnection } from '../src/testing/index.js';
import { SchemaValidator } from './support/json-schema.js';
import { accountSetup, USER, type AccountHarness } from './support/account.js';
import { conv, flush, setup, type Harness } from './helpers.js';

const schema = new SchemaValidator(
  JSON.parse(readFileSync(new URL('../protocol/schema/frame.schema.json', import.meta.url), 'utf8')),
);

const AB = 'c2c:alice:bob';
const G1 = 'group:g1';
const NOTE = 'ZXQ-RPT-NOTE';
const WORD = 'ZXQ-MOD-1';
const quiet = { timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } }; // 推进时钟时不因心跳断线

/** 服务端下发：先按 Schema 校验。 */
function down(c: FakeConnection, frame: Record<string, unknown>): void {
  expect(schema.errors(frame), JSON.stringify(frame)).toEqual([]);
  c.receive(frame);
}
const ackOk = (c: FakeConnection, cmd: string, data: Record<string, unknown>) =>
  down(c, { id: c.last(cmd).id, cmd: 'ack', data });
const ackErr = (c: FakeConnection, cmd: string, code: number, reason?: string) =>
  down(c, { id: c.last(cmd).id, cmd: 'ack', error: { code, msg: 'x', ...(reason ? { reason } : {}) } });

const reports = (c: FakeConnection) => c.frames().filter((f) => f.cmd === 'report');
const sends = (c: FakeConnection) => c.frames().filter((f) => f.cmd === 'send');

let current: Harness | null = null;
afterEach(() => {
  // AC-MOD-03-8 的 SDK 部分（FE-690 第 5 条）：日志里没有 note；第 6 条：也没有被拦截的内容。
  const logs = (current?.logs ?? []).join('\n');
  expect(logs).not.toContain(NOTE);
  expect(logs).not.toContain(WORD);
  current = null;
});

async function online(): Promise<[Harness, FakeConnection]> {
  const h = setup(quiet);
  current = h;
  h.im.connect('t');
  const c = await h.login('alice', [
    conv({ convId: AB, modVer: 0 }),
    conv({ convId: G1, modVer: 0, memberCount: 3, myRole: 'member' }),
  ]);
  return [h, c];
}

describe('report（F-MOD-03，AC-MOD-03-1、AC-MOD-03-9 的 SDK 部分）', () => {
  it('举报群里的一条消息：发 report 帧（符合 Schema），ack 的 reportId 原样返回；不发别的帧、不改本地数据', async () => {
    const [h, c] = await online();
    const before = c.frames().length;
    const convsBefore = JSON.stringify(h.im.conversations());
    let events = 0;
    for (const e of ['messages', 'conversations', 'sendFailed'] as const) h.im.on(e, () => events++);
    const p = h.im.report({ targetType: 'message', convId: G1, msgIds: ['m7'], reason: 'abuse' });
    expect(c.last('report').data).toEqual({ targetType: 'message', convId: G1, msgIds: ['m7'], reason: 'abuse' });
    ackOk(c, 'report', { reportId: 'rp_01J9ZXQ' });
    await expect(p).resolves.toBe('rp_01J9ZXQ');
    await flush();
    expect(
      c
        .frames()
        .slice(before)
        .map((f) => f.cmd),
    ).toEqual(['report']);
    for (const f of c.frames()) expect(schema.errors(f), f.cmd).toEqual([]);
    expect(JSON.stringify(h.im.conversations())).toBe(convsBefore);
    expect(events).toBe(0);
  });

  it('三种对象：单聊消息（带 note）、用户、群；note 原样（空串也发）', async () => {
    const [h, c] = await online();
    const inputs: ReportInput[] = [
      { targetType: 'message', convId: AB, msgIds: ['m1'], reason: 'spam', note: NOTE },
      { targetType: 'user', userId: 'bob', reason: 'fraud', note: '' },
      { targetType: 'group', groupId: 'g1', reason: 'illegal' },
    ];
    for (const input of inputs) {
      const p = h.im.report(input);
      ackOk(c, 'report', { reportId: 'rp_1' });
      await expect(p).resolves.toBe('rp_1');
    }
    expect(reports(c).map((f) => f.data)).toEqual(inputs);
    for (const f of c.frames()) expect(schema.errors(f), f.cmd).toEqual([]);
  });

  it('note 按码点数（frontend-chat 第 84 条）：200 个 emoji（400 个 UTF-16 单元）可以，201 个码点 4000 不发帧', async () => {
    const [h, c] = await online();
    const p = h.im.report({ targetType: 'user', userId: 'bob', reason: 'other', note: '😀'.repeat(REPORT_NOTE_MAX) });
    ackOk(c, 'report', { reportId: 'rp_2' });
    await expect(p).resolves.toBe('rp_2');
    const err = await h.im
      .report({ targetType: 'user', userId: 'bob', reason: 'other', note: 'a'.repeat(REPORT_NOTE_MAX + 1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IMError);
    expect(err).toMatchObject({ code: ErrorCode.BAD_REQUEST, details: { field: 'note' } });
    expect(reports(c)).toHaveLength(1);
  });

  it('msgIds 20 条可以发（协议上限）；第一批页面只传 1 条，接口保留数组', async () => {
    const [h, c] = await online();
    const ids = Array.from({ length: 20 }, (_, i) => `m${i + 1}`);
    const p = h.im.report({ targetType: 'message', convId: G1, msgIds: ids, reason: 'porn' });
    ackOk(c, 'report', { reportId: 'rp_3' });
    await expect(p).resolves.toBe('rp_3');
    expect(c.last('report').data['msgIds']).toEqual(ids);
  });

  it('参数不合法：本地直接抛 4000（details.field），不发帧；错误信息里没有 note', async () => {
    const [h, c] = await online();
    const cases: Array<[unknown, string]> = [
      [{ targetType: 'message', convId: G1, msgIds: [], reason: 'abuse' }, 'msgIds'],
      [
        { targetType: 'message', convId: G1, msgIds: Array.from({ length: 21 }, (_, i) => `m${i}`), reason: 'abuse' },
        'msgIds',
      ],
      [{ targetType: 'message', convId: G1, msgIds: ['m 7'], reason: 'abuse' }, 'msgIds'],
      [{ targetType: 'message', convId: G1, msgIds: 'm7', reason: 'abuse' }, 'msgIds'],
      [{ targetType: 'message', convId: G1, reason: 'abuse' }, 'msgIds'],
      [{ targetType: 'message', msgIds: ['m7'], reason: 'abuse' }, 'convId'],
      [{ targetType: 'message', convId: 'room:r1', msgIds: ['m7'], reason: 'abuse' }, 'convId'],
      [{ targetType: 'message', convId: 'g1', msgIds: ['m7'], reason: 'abuse' }, 'convId'],
      [{ targetType: 'message', convId: 'c2c:bob:carol', msgIds: ['m7'], reason: 'abuse' }, 'convId'], // 自己不是参与者
      [{ targetType: 'message', convId: G1, msgIds: ['m7'], userId: 'bob', reason: 'abuse' }, 'targetType'],
      [{ targetType: 'message', convId: G1, msgIds: ['m7'], groupId: 'g1', reason: 'abuse' }, 'targetType'],
      [{ targetType: 'user', reason: 'spam' }, 'userId'],
      [{ targetType: 'user', userId: 'u 9', reason: 'spam' }, 'userId'],
      [{ targetType: 'user', userId: 'bob', convId: AB, reason: 'spam' }, 'targetType'],
      [{ targetType: 'user', userId: 'bob', msgIds: ['m7'], reason: 'spam' }, 'targetType'],
      [{ targetType: 'group', reason: 'spam' }, 'groupId'],
      [{ targetType: 'group', groupId: 'g/1', reason: 'spam' }, 'groupId'],
      [{ targetType: 'group', groupId: 'g1', userId: 'bob', reason: 'spam' }, 'targetType'],
      [{ targetType: 'conv', convId: G1, reason: 'spam' }, 'targetType'],
      [{ userId: 'bob', reason: 'spam' }, 'targetType'],
      [{ targetType: 'user', userId: 'bob', reason: 'xxx', note: NOTE }, 'reason'],
      [{ targetType: 'user', userId: 'bob' }, 'reason'],
      [{ targetType: 'user', userId: 'bob', reason: 'spam', note: 7 }, 'note'],
      [{ targetType: 'user', userId: 'bob', reason: 'spam', note: NOTE + 'x'.repeat(200) }, 'note'],
      [{ targetType: 'user', userId: 'bob', reason: 'spam', evidence: true }, 'evidence'], // Schema 不允许多余字段
      [null, 'input'],
    ];
    for (const [input, field] of cases) {
      const err = await h.im.report(input as ReportInput).catch((e: unknown) => e);
      expect(err, JSON.stringify(input)).toBeInstanceOf(IMError);
      expect(err, JSON.stringify(input)).toMatchObject({ code: 4000, details: { field } });
      expect(String(err) + JSON.stringify(err)).not.toContain(NOTE);
    }
    expect(reports(c)).toHaveLength(0);
  });

  it('4292、4040 reportTargetInvalid、4030 featureDisabled、4290、5000 原样抛出，不自动重试（推进时间、重连后也只有 1 帧）', async () => {
    const [h, c] = await online();
    const cases: Array<[number, string | undefined, string | undefined]> = [
      [4292, undefined, '今天的举报次数已用完'],
      [4040, 'reportTargetInvalid', '无法举报该内容'],
      [4030, 'featureDisabled', '举报功能暂不可用'],
      [4290, undefined, '操作太频繁，请稍后再试'],
      [5000, undefined, undefined],
    ];
    for (const [code, reason, copy] of cases) {
      const p = h.im.report({ targetType: 'message', convId: AB, msgIds: ['m1'], reason: 'abuse', note: NOTE });
      ackErr(c, 'report', code, reason);
      const err = await p.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IMError);
      expect(err).toMatchObject({ code, reason });
      expect(messageFor('report', code)).toBe(copy);
      expect(String(err)).not.toContain(NOTE);
    }
    expect(reports(c)).toHaveLength(cases.length);
    h.clock.advance(120_000);
    c.drop();
    h.clock.advance(60_000);
    await flush();
    const n = await h.login('alice', []);
    await flush();
    expect(reports(n)).toHaveLength(0);
    expect(JSON.stringify(h.im.debugExport())).not.toContain(NOTE);
  });

  it('超时抛 TimeoutError，不重试；未连接抛 NotConnectedError，不发帧', async () => {
    const [h, c] = await online();
    const p = h.im.report({ targetType: 'user', userId: 'bob', reason: 'abuse', note: NOTE });
    const settled = p.catch((e: unknown) => e);
    h.clock.advance(60_000);
    expect(await settled).toBeInstanceOf(TimeoutError);
    h.clock.advance(60_000);
    await flush();
    expect(reports(c)).toHaveLength(1);
    h.im.disconnect();
    await expect(h.im.report({ targetType: 'user', userId: 'bob', reason: 'abuse' })).rejects.toBeInstanceOf(
      NotConnectedError,
    );
    expect(reports(c)).toHaveLength(1);
  });
});

describe('4510（F-MOD-02 规则 6，AC-MOD-02-9 的 SDK 部分，frontend-chat 第 81 条）', () => {
  it('send 收到 4510：标记失败、error=4510，sendFailed 只带码；错误里没有内容；不自动重发，也不能手动重发', async () => {
    const [h, c] = await online();
    const failed: unknown[] = [];
    h.im.on('sendFailed', (...a) => failed.push(a));
    const r = h.im.send(AB, `含 ${WORD} 的消息`);
    if (!r.ok) throw new Error('send');
    const id = r.message.clientMsgId;
    ackErr(c, 'send', 4510);
    await flush();
    const m = h.im.messages(AB).find((x) => x.clientMsgId === id)!;
    expect(m).toMatchObject({ status: 'failed', error: ErrorCode.CONTENT_BLOCKED });
    expect(m.errorReason).toBeUndefined();
    expect(failed).toEqual([[AB, id, 4510]]);
    expect(JSON.stringify(failed)).not.toContain(WORD);
    expect(messageFor('send', 4510)).toBe('消息包含不当内容，无法发送');
    expect(h.im.canRetry(m)).toBe(false);

    h.im.retry(AB, id); // 页面没有"重发"按钮；直接调用也不发
    h.clock.advance(60_000);
    c.drop();
    h.clock.advance(60_000);
    await flush();
    const n = await h.login('alice', []);
    await flush();
    expect(sends(c)).toHaveLength(1);
    expect(sends(n)).toHaveLength(0);
    expect(h.im.messages(AB).find((x) => x.clientMsgId === id)).toMatchObject({ status: 'failed', error: 4510 });
    expect(h.im.removeFailed(AB, id)).toBe(true); // "删除"照常
  });

  it('对照：5000 失败的可以重发（canRetry 为 true，retry 再发一次）', async () => {
    const [h, c] = await online();
    const r = h.im.send(AB, 'hi');
    if (!r.ok) throw new Error('send');
    ackErr(c, 'send', 5000);
    await flush();
    const m = h.im.messages(AB)[0]!;
    expect(h.im.canRetry(m)).toBe(true);
    h.im.retry(AB, m.clientMsgId);
    expect(sends(c)).toHaveLength(2);
  });

  it('超时标记失败之后才到的 4510：失败原因改成 4510，不再能重发', async () => {
    const [h, c] = await online();
    const r = h.im.send(AB, `含 ${WORD}`);
    if (!r.ok) throw new Error('send');
    const id = c.last('send').id;
    h.clock.advance(11_000);
    await flush();
    const m0 = h.im.messages(AB)[0]!;
    expect(m0).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(h.im.canRetry(m0)).toBe(true);
    down(c, { id, cmd: 'ack', error: { code: 4510, msg: 'content blocked' } });
    await flush();
    const m = h.im.messages(AB)[0]!;
    expect(m).toMatchObject({ status: 'failed', error: 4510 });
    expect(h.im.canRetry(m)).toBe(false);
  });

  it('sourceMissing 的也不能重发（只能删除）', () => {
    const h = setup();
    const m: Pick<Message, 'status' | 'error'> = { status: 'failed', error: 'sourceMissing' };
    expect(h.im.canRetry(m)).toBe(false);
    expect(h.im.canRetry({ status: 'sent' })).toBe(false);
    expect(h.im.canRetry({ status: 'failed', error: 'timeout' })).toBe(true);
  });

  describe('图片、文件（文件名命中，AC-MOD-02-4 的客户端侧）', () => {
    let acc: AccountHarness | null = null;
    afterEach(() => {
      expect(acc?.badRequests ?? []).toEqual([]);
      expect((acc?.logs ?? []).join('\n')).not.toContain(WORD);
      acc = null;
    });
    const ab = `c2c:${USER}:bob`;
    const put = (k: string) => ({ url: `https://s3.test/${k}?X-Amz-Signature=1`, headers: {}, expiresAt: 1 });

    for (const kind of ['image', 'file'] as const) {
      it(`${kind}：send 回 4510 标记失败、error=4510，不重新上传、不重发`, async () => {
        const h = (acc = accountSetup());
        h.session(1, 24 * 3_600_000);
        const c = await h.online();
        const m =
          kind === 'image'
            ? h.im.sendImage(ab, {
                original: { data: new Uint8Array(1000), mime: 'image/jpeg' },
                thumb: { data: new Uint8Array(100), mime: 'image/jpeg' },
                width: 10,
                height: 10,
              })
            : h.im.sendFile(ab, { data: new Uint8Array(10), name: `${WORD}.pdf`, mime: 'application/pdf' });
        await flush();
        h.http
          .last('/v1/files/uploads')
          .respond(200, { fileId: 'F1', put: put('o'), ...(kind === 'image' ? { thumbPut: put('t') } : {}) });
        await flush();
        for (const u of [...h.upload.pending]) u.respond(200);
        await flush();
        for (const u of [...h.upload.pending]) u.respond(200);
        await flush();
        h.http
          .last('/v1/files/F1/complete')
          .respond(
            200,
            kind === 'image'
              ? { fileId: 'F1', size: 1000, mime: 'image/jpeg', width: 10, height: 10, thumbSize: 100 }
              : { fileId: 'F1', size: 10, mime: 'application/pdf' },
          );
        await flush();
        expect(sends(c)).toHaveLength(1);
        ackErr(c, 'send', 4510);
        await flush();
        const now = h.im.messages(ab).find((x) => x.clientMsgId === m.clientMsgId)!;
        expect(now).toMatchObject({ status: 'failed', error: 4510 });
        expect(h.im.canRetry(now)).toBe(false);
        const uploads = h.http.to('/v1/files/uploads').length;
        h.im.retry(ab, m.clientMsgId);
        h.clock.advance(60_000);
        await flush();
        expect(sends(c)).toHaveLength(1);
        expect(h.http.to('/v1/files/uploads')).toHaveLength(uploads);
      });
    }
  });

  it('其他 WS 命令（建群、改群名和公告、好友申请）的 4510 原样抛出，文案用非消息那句（P-48 ⑥）', async () => {
    const [h, c] = await online();
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['groupCreate', () => h.im.createGroup({ name: WORD, members: ['bob'] })],
      ['groupUpdate', () => h.im.updateGroup('g1', { notice: WORD })],
      ['friendApply', () => h.im.applyFriend('carol', { message: WORD })],
    ];
    for (const [cmd, call] of calls) {
      const p = call().catch((e: unknown) => e);
      await flush();
      ackErr(c, cmd, 4510);
      const err = await p;
      expect(err, cmd).toBeInstanceOf(IMError);
      expect(err, cmd).toMatchObject({ code: 4510, details: undefined });
      expect(messageFor(cmd, 4510)).toBe('内容包含不当信息，请修改后重试');
    }
    expect(c.frames().filter((f) => f.cmd === 'groupCreate')).toHaveLength(1); // 4510 不是超时，不重试
  });
});

describe('账号接口的 4510（注册、改昵称，HTTP 451）原样抛出', () => {
  let acc: AccountHarness | null = null;
  afterEach(() => {
    expect(acc?.badRequests ?? []).toEqual([]);
    expect((acc?.logs ?? []).join('\n')).not.toContain(WORD);
    acc = null;
  });

  it('register、updateProfile：AccountError {status 451, code 4510}，没有 details；会话不受影响', async () => {
    const h = (acc = accountSetup());
    const reg = h.account.register({ username: 'carol_1', password: 'Password-1', inviteCode: 'INV', nickname: WORD });
    await flush();
    h.http.last('/v1/account/register').respondError(451, 4510, { msg: 'content blocked' });
    const e1 = await reg.catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AccountError);
    expect(e1).toMatchObject({ status: 451, code: 4510, details: undefined });
    expect(messageFor('register', 4510)).toBe('内容包含不当信息，请修改后重试');

    h.session(1, 24 * 3_600_000);
    const up = h.account.updateProfile({ nickname: WORD });
    await flush();
    h.http.last('/v1/account/profile').respondError(451, 4510, { msg: 'content blocked' });
    const e2 = await up.catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(AccountError);
    expect(e2).toMatchObject({ status: 451, code: 4510 });
    expect(h.account.session).not.toBeNull();
    expect(h.http.to('/v1/account/profile')).toHaveLength(1);
  });
});

describe('features.moderation（backend-chat 第 96 条，frontend-chat 第 76 条）', () => {
  it('开、关、老服务端没有这个字段都能直接读（没有按关闭处理）', async () => {
    for (const [features, want] of [
      [{ files: true, moderation: true }, true],
      [{ files: true, moderation: false }, false],
      [{ files: true }, undefined],
    ] as const) {
      const h = accountSetup();
      const p = h.account.getConfig();
      await flush();
      h.http.last('/v1/config').respond(200, { registerMode: 'open', demoLogin: false, features, limits: {} });
      const on: boolean | undefined = (await p).features.moderation;
      expect(on).toBe(want);
      expect(on === true).toBe(want === true);
    }
  });
});
