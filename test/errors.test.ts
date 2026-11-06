import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES, CloseCode, ERROR_REASONS, ErrorCode, describeError } from '../src/index.js';

const spec = JSON.parse(readFileSync(new URL('../protocol/errors.json', import.meta.url), 'utf8'));

describe('错误码（AC-SYS-01-3、AC-SYS-01-4、C-09）', () => {
  it('生成的枚举与 errors.json 完全一致', () => {
    // 只属于 console-server 的码不进终端 SDK（PRD-admin 10.1 节）。
    const forSdk = spec.errors.filter((e: { scope: string[] }) => e.scope.some((x) => x !== 'console'));
    expect(Object.keys(ErrorCode)).toHaveLength(forSdk.length);
    expect(forSdk.length).toBeLessThan(spec.errors.length);
    for (const e of forSdk as Array<{ name: string; code: number; retryable: boolean }>) {
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

  it('TC-CHAT-90-12 client scope 的码都在枚举里，和 errors.json 一致（AC-CHAT-90-14）', () => {
    const client = spec.errors.filter((e: { scope: string[] }) => e.scope.includes('client'));
    expect(client.length).toBeGreaterThan(0);
    expect([...CLIENT_ERROR_CODES].sort()).toEqual(client.map((e: { code: number }) => e.code).sort());
    for (const e of client as Array<{ name: string; code: number }>) {
      expect((ErrorCode as Record<string, number>)[e.name]).toBe(e.code);
    }
    for (const name of [
      'ACCOUNT_CREDENTIALS_INVALID',
      'REFRESH_TOKEN_INVALID',
      'USERNAME_TAKEN',
      'ACCOUNT_LOGIN_LOCKED',
    ]) {
      expect(ErrorCode).toHaveProperty(name);
    }
    const { $comment: _ignored, ...reasons } = spec.reasons as Record<string, unknown>;
    expect(ERROR_REASONS).toEqual(reasons);
  });
});
