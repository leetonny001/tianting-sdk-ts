import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkText, countCodePoints, trimText } from '../src/index.js';

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/text.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; input: string; trimmed: string; length: number }>;
};

describe('文本规则：与服务端共用 protocol/vectors/text.json（C-26、AC-MSG-01-2、AC-MSG-01-3）', () => {
  for (const c of spec.cases) {
    it(c.name, () => {
      expect(trimText(c.input)).toBe(c.trimmed);
      expect(countCodePoints(c.trimmed)).toBe(c.length);
    });
  }

  it('checkText：空白、5000、5001', () => {
    expect(checkText(' \n\t　 ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(checkText('字'.repeat(5000))).toMatchObject({ ok: true });
    expect(checkText('😀'.repeat(5000))).toMatchObject({ ok: true });
    expect(checkText('字'.repeat(5003))).toEqual({ ok: false, reason: 'tooLong', text: '字'.repeat(5003), over: 3 });
    expect(checkText('  hi  ')).toEqual({ ok: true, text: 'hi' });
  });
});
