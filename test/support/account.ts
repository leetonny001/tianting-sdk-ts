import { readFileSync } from 'node:fs';
import { AccountClient, type AccountSession, type SessionStore } from '../../src/index.js';
import { FakeClock, FakeHttp } from '../../src/testing/index.js';
import { setup, type Harness } from '../helpers.js';
import { SchemaValidator } from './json-schema.js';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export const httpSchema = JSON.parse(
  readFileSync(new URL('../../protocol/schema/http-client.schema.json', import.meta.url), 'utf8'),
) as Record<string, unknown> & {
  endpoints: Record<string, { request?: string; response: string }>;
};
export const httpValidator = new SchemaValidator(httpSchema);

export const USER = 'alice_1';
export const REFRESH = '/v1/account/token/refresh';
export const PASSWORD = '/v1/account/password';
export const HOUR = 3_600_000;

/** 和服务端形状相同的 access token（只有 sid、gen 对 SDK 有意义）。 */
export function jwt(sid: string, gen: number, sub = USER): string {
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify({ sub, sid, gen }))}.SIGNATURE-${sid}-${gen}`;
}

export function refreshToken(sid: string, gen: number): string {
  return `k1.${sid}.${gen}.NONCE${gen}.MAC${gen}`;
}

export interface AuthOpts {
  sid?: string;
  gen: number;
  accessExpiresAt: number;
  absoluteExpiresAt?: number;
  recoveryCode?: string;
  recoveryCodeGen?: number;
  recoveryCodeUnacked?: boolean;
}

/** 刷新、登录等的响应。按 Schema 校验，假数据不会和真实服务端走样。 */
export function authBody(o: AuthOpts): Record<string, unknown> {
  const sid = o.sid ?? 'sid1';
  const body = {
    userId: USER,
    accessToken: jwt(sid, o.gen),
    accessExpiresAt: o.accessExpiresAt,
    refreshToken: refreshToken(sid, o.gen),
    refreshExpiresAt: o.accessExpiresAt + 24 * HOUR,
    absoluteExpiresAt: o.absoluteExpiresAt ?? o.accessExpiresAt + 365 * 24 * HOUR,
    ...(o.recoveryCode ? { recoveryCode: o.recoveryCode, recoveryCodeGen: o.recoveryCodeGen ?? 2 } : {}),
    ...(o.recoveryCodeUnacked ? { recoveryCodeUnacked: true } : {}),
  };
  const errs = httpValidator.errors(body, '#/$defs/AuthResponse');
  if (errs.length) throw new Error(`authBody: ${errs.join('; ')}`);
  return body;
}

export class MemoryStore implements SessionStore {
  saved: AccountSession | null = null;
  saves: AccountSession[] = [];
  clears = 0;
  /** 让下一次 save 失败。 */
  failSave = false;
  load(): AccountSession | null {
    return this.saved;
  }
  save(s: AccountSession): void {
    if (this.failSave) throw new Error('disk full');
    this.saved = s;
    this.saves.push(s);
  }
  clear(): void {
    this.saved = null;
    this.clears += 1;
  }
}

export interface AccountHarness extends Harness {
  http: FakeHttp;
  account: AccountClient;
  store: MemoryStore;
  /** 不符合 http-client.schema.json 的请求体。 */
  badRequests: string[];
  /** 同一时间最多有几个没回应答的请求。 */
  maxPending: () => number;
  /** 用 tokenProvider 连接并完成 auth。 */
  online(): Promise<ReturnType<Harness['login']> extends Promise<infer C> ? C : never>;
  /** 恢复一个账号会话。 */
  session(gen: number, accessLeftMs: number, sid?: string): AccountSession;
}

const START = 1_800_000_000_000;

export function accountSetup(): AccountHarness {
  const clock = new FakeClock(START);
  // 这里测的不是心跳：关掉，否则推进时钟时没人回 pong，连接会被判定断开。
  const h = setup({ clock, timings: { heartbeatMs: 10 * 365 * 24 * HOUR } });
  const http = new FakeHttp();
  const store = new MemoryStore();
  const badRequests: string[] = [];
  let peak = 0;
  http.onRequest = (call) => {
    peak = Math.max(peak, http.pending.length);
    const ep = httpSchema.endpoints[`${call.req.method} ${call.path}`];
    if (!ep) {
      badRequests.push(`no endpoint ${call.req.method} ${call.path}`);
    } else if (ep.request) {
      badRequests.push(...httpValidator.errors(call.json, `#/$defs/${ep.request}`).map((e) => `${call.path} ${e}`));
    }
  };
  const logger = {
    debug: (m: string) => h.logs.push(m),
    warn: (m: string) => h.logs.push(m),
    error: (m: string, e?: unknown) => h.logs.push(`${m} ${String(e)}`),
  };
  const account = new AccountClient({
    baseUrl: 'https://im.test',
    platform: 'web',
    http,
    clock,
    store,
    logger,
    random: () => 0.5,
  });
  const out: AccountHarness = {
    ...h,
    http,
    account,
    store,
    badRequests,
    maxPending: () => peak,
    async online() {
      h.im.connect(account.tokenProvider);
      await flushNow();
      return h.login(USER);
    },
    session(gen, accessLeftMs, sid = 'sid1') {
      const s: AccountSession = {
        mode: 'account',
        userId: USER,
        accessToken: jwt(sid, gen),
        accessExpiresAt: clock.now() + accessLeftMs,
        refreshToken: refreshToken(sid, gen),
        refreshExpiresAt: clock.now() + 24 * HOUR,
        absoluteExpiresAt: clock.now() + 365 * 24 * HOUR,
      };
      account.restore(s);
      store.saved = s;
      return s;
    },
  };
  return out;
}

async function flushNow(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}
