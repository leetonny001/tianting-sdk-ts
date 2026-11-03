import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CloseCode, ErrorCode, describeError } from '../src/index.js';

const spec = JSON.parse(readFileSync(new URL('../protocol/errors.json', import.meta.url), 'utf8'));

describe('错误码（AC-SYS-01-3、AC-SYS-01-4、C-09）', () => {
  it('生成的枚举与 errors.json 完全一致', () => {
    expect(Object.keys(ErrorCode)).toHaveLength(spec.errors.length);
    for (const e of spec.errors) {
      expect((ErrorCode as Record<string, number>)[e.name]).toBe(e.code);
      expect(describeError(e.code)).toMatchObject({ name: e.name, retryable: e.retryable });
    }
    for (const c of spec.closeCodes) expect((CloseCode as Record<string, number>)[c.name]).toBe(c.code);
  });

  it('src/errors.gen.ts 没有落后于 errors.json', () => {
    execFileSync('node', ['scripts/gen-errors.mjs', '--check'], { cwd: new URL('..', import.meta.url) });
  });

  it('不认识的错误码按区段兜底', () => {
    expect(describeError(4999)).toEqual({ code: 4999, name: 'UNKNOWN', category: 'badRequest', retryable: false });
    expect(describeError(4039).category).toBe('forbidden');
    expect(describeError(4049).category).toBe('notFound');
    expect(describeError(4299)).toMatchObject({ category: 'rateLimited', retryable: false });
    expect(describeError(5999)).toMatchObject({ category: 'server', retryable: true });
  });
});
