// TC-CHAT-90-09（AC-CHAT-90-10，sdk-ts 部分）：协议用例的 Schema 校验。之前 sdk-ts 只验下行不抛异常，测不出格式差异。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './support/json-schema.js';
import { conv, flush, msg, setup } from './helpers.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(`../protocol/${p}`, import.meta.url), 'utf8'));
const frames = read('vectors/frames.json') as {
  valid: Array<{ name: string; frame: unknown }>;
  invalid: Array<{ name: string; frame: unknown }>;
};
const validator = new SchemaValidator(read('schema/frame.schema.json'));

describe('TC-CHAT-90-09 frames.json 按 frame.schema.json 校验', () => {
  // C4 的新帧（recall、quote、mentions、msgDeleted.recalled、mentionUnread、groupMembers 的 keyword）是 TC-CHAT-90-32。
  // C5 的新帧（convSet、convDelete、convSettingsChanged、convDeleted、pinned、notifyOff、deleted）是 TC-CHAT-90-38。
  const tc = (name: string) =>
    name.includes('（C4') ? 'TC-CHAT-90-32 ' : name.includes('（C5') ? 'TC-CHAT-90-38 ' : '';
  for (const v of frames.valid) {
    it(`${tc(v.name)}合法：${v.name}`, () => {
      expect(validator.errors(v.frame)).toEqual([]);
    });
  }
  for (const v of frames.invalid) {
    it(`${tc(v.name)}非法：${v.name}`, () => {
      expect(validator.errors(v.frame)).not.toEqual([]);
    });
  }

  it('C1 的帧：kicked 带 recoverBefore、新的踢线原因、securityNotice、auth ack 的 recoveryCodeUnacked', () => {
    const event = (data: unknown) => ({ cmd: 'event', data });
    for (const reason of ['passwordChanged', 'sessionRevoked', 'accountDeleted']) {
      expect(validator.errors(event({ type: 'kicked', reason, recoverBefore: 1_800_000_000_000 }))).toEqual([]);
    }
    expect(
      validator.errors(
        event({ type: 'securityNotice', kind: 'newDeviceLogin', at: 1_800_000_000_000, platform: 'ios' }),
      ),
    ).toEqual([]);
    expect(validator.errors(event({ type: 'securityNotice', kind: 'x', at: 1_800_000_000_000 }))).not.toEqual([]);
    expect(
      validator.errors({
        id: 'a1',
        cmd: 'ack',
        data: { userId: 'alice', serverTime: 1_800_000_000_000, recoveryCodeUnacked: true },
      }),
    ).toEqual([]);
  });

  it('校验器遇到没实现的关键字直接报错，不静默放过', () => {
    expect(() => new SchemaValidator({ unevaluatedProperties: false }).errors({})).toThrow(/not implemented/);
  });

  it('SDK 发出的帧符合 Schema', async () => {
    const h = setup();
    h.im.connect('token-value');
    const c = await h.login();
    h.im.send('c2c:alice:bobby', 'hi');
    await flush();
    expect(c.frames().length).toBeGreaterThanOrEqual(3);
    for (const f of c.frames()) expect(validator.errors(f), f.cmd).toEqual([]);
  });

  it('TC-CHAT-90-32 SDK 发出的 C4 帧符合 Schema：recall、send 带 quote 和 mentions、groupMembers 带 keyword', async () => {
    const h = setup();
    h.im.connect('token-value');
    const g = 'group:g1';
    const c = await h.login('alice', [conv({ convId: g, maxSeq: 3, myRole: 'owner' })]);
    void h.im.loadHistory(g);
    await flush();
    c.ack('sync', { messages: [{ ...msg(g, 3, 'bob', '被引用的原文'), msgId: 'm3' }], hasMore: false });
    await flush();
    h.im.send(g, '@bob 看这条', { quote: { msgId: 'm3' }, mentions: { userIds: ['bob', 'bob'] } });
    h.im.send(g, '@所有人 开会', { mentions: { all: true } });
    h.im.send('c2c:alice:bob', '单聊引用', { quote: { msgId: 'm1' } });
    void h.im.recall(g, 'm3').catch(() => undefined);
    void h.im.searchGroupMembers('g1', 'zh').catch(() => undefined);
    await flush();
    const cmds = c.frames().map((f) => f.cmd);
    expect(cmds).toEqual(expect.arrayContaining(['recall', 'send', 'groupMembers']));
    for (const f of c.frames()) expect(validator.errors(f), f.cmd).toEqual([]);
    expect(c.last('groupMembers').data).toEqual({ groupId: 'g1', keyword: 'zh' });
  });

  it('TC-CHAT-90-38 SDK 发出的 C5 帧符合 Schema：convSet（pinned、notifyOff）、convDelete（upToSeq，空会话为 0）', async () => {
    const h = setup();
    h.im.connect('token-value');
    const g = 'group:g1';
    const c = await h.login('alice', [conv({ convId: g, maxSeq: 3, myRole: 'owner' })]);
    void h.im.setConvPinned(g, true).catch(() => undefined);
    void h.im.setConvPinned(g, false).catch(() => undefined);
    void h.im.setConvNotifyOff('c2c:alice:bob', true).catch(() => undefined);
    void h.im.deleteConv(g).catch(() => undefined);
    void h.im.deleteConv('group:empty').catch(() => undefined);
    await flush();
    const sent = c.frames().filter((f) => f.cmd === 'convSet' || f.cmd === 'convDelete');
    expect(sent.map((f) => f.data)).toEqual([
      { convId: g, pinned: true },
      { convId: g, pinned: false },
      { convId: 'c2c:alice:bob', notifyOff: true },
      { convId: g, upToSeq: 3 },
      { convId: 'group:empty', upToSeq: 0 },
    ]);
    for (const f of c.frames()) expect(validator.errors(f), f.cmd).toEqual([]);
  });
});
