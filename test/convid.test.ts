import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConvIdError, parseConvIdStrict, peerId } from '../src/index.js';

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/convid.json', import.meta.url), 'utf8')) as {
  self: string;
  cases: { convId: string; ok?: { convType: string; to: string }; error?: string }[];
};

describe('严格解析会话 ID：与其他 SDK 共用 protocol/vectors/convid.json（AC-UI-33-13、G-UI-03）', () => {
  for (const c of spec.cases) {
    it(`${JSON.stringify(c.convId)} → ${c.ok ? JSON.stringify(c.ok) : c.error}`, () => {
      if (c.ok) {
        expect(parseConvIdStrict(c.convId, spec.self)).toEqual(c.ok);
        return;
      }
      let err: unknown;
      try {
        parseConvIdStrict(c.convId, spec.self);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConvIdError);
      expect((err as ConvIdError).kind).toBe(c.error);
    });
  }

  it('peerId：单聊返回对方，群返回 null', () => {
    expect(peerId({ convId: 'c2c:alice:bob', type: 'c2c' }, 'alice')).toBe('bob');
    expect(peerId({ convId: 'c2c:alice:bob', type: 'c2c' }, 'bob')).toBe('alice');
    expect(peerId({ convId: 'group:g1', type: 'group' }, 'alice')).toBeNull();
  });
});
