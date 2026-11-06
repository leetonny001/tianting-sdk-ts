// TC-CHAT-90-09（AC-CHAT-90-10，sdk-ts 部分）：协议用例的 Schema 校验。之前 sdk-ts 只验下行不抛异常，测不出格式差异。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SchemaValidator } from './support/json-schema.js';
import { setup, flush } from './helpers.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(`../protocol/${p}`, import.meta.url), 'utf8'));
const frames = read('vectors/frames.json') as {
  valid: Array<{ name: string; frame: unknown }>;
  invalid: Array<{ name: string; frame: unknown }>;
};
const validator = new SchemaValidator(read('schema/frame.schema.json'));

describe('TC-CHAT-90-09 frames.json 按 frame.schema.json 校验', () => {
  for (const v of frames.valid) {
    it(`合法：${v.name}`, () => {
      expect(validator.errors(v.frame)).toEqual([]);
    });
  }
  for (const v of frames.invalid) {
    it(`非法：${v.name}`, () => {
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
});
