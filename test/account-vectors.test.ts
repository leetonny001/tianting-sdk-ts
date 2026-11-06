// TC-CHAT-90-13（AC-CHAT-90-15）：共享用例 protocol/vectors/account-session.json。
// cases 用真实的 AccountClient + 假 HTTP + 假时钟跑：refresh 真的发了请求，refreshOk 真的是 HTTP 响应，requestTimeout 真的是时钟走了 30 秒。
// 被踢入口（source=kicked）直接调 AccountClient.trigger，也就是连接调用的同一个入口；经过 FakeTransport 的路径在 account-session.test.ts。
// serverCases 约束 test/support/fake-account-server.ts，这里再用它当假服务端跑一段 SDK。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AccountClient, lineageOf, type SessionOutcome } from '../src/index.js';
import { FakeClock, FakeHttp } from '../src/testing/index.js';
import { REFRESH, USER, accountSetup, authBody, jwt, refreshToken } from './support/account.js';
import { FakeAccountSession } from './support/fake-account-server.js';
import { flush } from './helpers.js';

interface Step {
  op: 'trigger' | 'http4011' | 'requestTimeout' | 'refreshOk' | 'refreshFailed';
  source?: 'start' | 'foreground' | 'timer' | 'kicked';
  nowMs?: number;
  rejectedGen?: number;
  attempt?: number;
  tokens?: { accessGen: number; accessExpiresAt: number; absoluteExpiresAt: number };
  failure?: { code: number; reason?: string; retryAfterSeconds?: number; recoverBefore?: number };
  expect: SessionOutcome;
  localGen: number;
  inflight: boolean;
}
interface Case {
  name: string;
  rule: string;
  start: { mode: 'account' | 'demo'; accessGen: number; accessExpiresAt: number; absoluteExpiresAt: number };
  steps: Step[];
}
interface ServerStep {
  op: 'refresh' | 'access' | 'advance';
  gen?: number;
  ms?: number;
  repeat?: number;
  result?: string;
  newGen?: number;
  current: number;
  revoked: boolean;
  overlapMinGen: number;
  inWindow: boolean;
  pendings: number[];
}

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/account-session.json', import.meta.url), 'utf8')) as {
  cases: Case[];
  serverCases: Array<{ name: string; rule: string; steps: ServerStep[] }>;
};

const HTTP_STATUS: Record<number, number> = { 4019: 401, 4290: 429, 5030: 503, 4034: 403 };

describe('TC-CHAT-90-13 account-session.json cases（规则 5、6、6a、7）', () => {
  it('用例集不是空的，四个入口、各种失败都覆盖到了', () => {
    expect(spec.cases.length).toBeGreaterThanOrEqual(20);
    const sources = new Set(spec.cases.flatMap((c) => c.steps.map((s) => s.source)));
    for (const s of ['start', 'foreground', 'timer', 'kicked']) expect(sources).toContain(s);
  });

  for (const c of spec.cases) {
    it(`${c.name}（${c.rule}）`, async () => {
      const clock = new FakeClock(c.steps.find((s) => s.nowMs)?.nowMs ?? 1_800_000_000_000);
      const http = new FakeHttp();
      const account = new AccountClient({ baseUrl: 'https://im.test', http, clock, random: () => 0.5 });
      account.restore({
        mode: c.start.mode,
        userId: USER,
        accessToken: jwt('sid1', c.start.accessGen),
        accessExpiresAt: c.start.accessExpiresAt,
        absoluteExpiresAt: c.start.absoluteExpiresAt,
        ...(c.start.mode === 'account' ? { refreshToken: refreshToken('sid1', c.start.accessGen) } : {}),
      });
      expect(lineageOf(account.session?.accessToken ?? '').gen).toBe(c.start.accessGen);
      const outcomes: SessionOutcome[] = [];
      account.on('outcome', (o) => outcomes.push(o));
      let attempts = 0;
      for (const [i, s] of c.steps.entries()) {
        const at = `${c.name} 第 ${i + 1} 步 ${s.op}`;
        outcomes.length = 0;
        switch (s.op) {
          case 'trigger':
            if (s.nowMs !== undefined && s.nowMs > clock.now()) clock.advance(s.nowMs - clock.now());
            account.trigger(s.source!, s.rejectedGen !== undefined ? { gen: s.rejectedGen } : undefined);
            break;
          case 'http4011':
            account.http4011({ gen: s.rejectedGen ?? 0 });
            break;
          case 'requestTimeout':
            clock.advance(30_000);
            break;
          case 'refreshOk':
            http.to(REFRESH)[s.attempt! - 1]!.respond(
              200,
              authBody({
                gen: s.tokens!.accessGen,
                accessExpiresAt: s.tokens!.accessExpiresAt,
                absoluteExpiresAt: s.tokens!.absoluteExpiresAt,
              }),
            );
            break;
          case 'refreshFailed': {
            const f = s.failure!;
            const call = http.to(REFRESH)[s.attempt! - 1]!;
            if (f.code === 0) {
              call.fail();
            } else {
              const details = {
                ...(f.retryAfterSeconds ? { retryAfterSeconds: f.retryAfterSeconds } : {}),
                ...(f.recoverBefore ? { recoverBefore: f.recoverBefore } : {}),
              };
              call.respondError(HTTP_STATUS[f.code] ?? 400, f.code, {
                ...(f.reason ? { reason: f.reason } : {}),
                ...(Object.keys(details).length ? { details } : {}),
              });
            }
            break;
          }
        }
        await flush();
        expect(outcomes.at(-1) ?? { action: 'none' }, at).toEqual(s.expect);
        expect(account.localGen, `${at} localGen`).toBe(s.localGen);
        expect(account.refreshInflight, `${at} inflight`).toBe(s.inflight);
        if (s.expect.action === 'refresh') attempts = s.expect.attempt;
        expect(http.to(REFRESH).length, `${at} 发出的刷新请求数`).toBe(attempts);
      }
    });
  }
});

describe('TC-CHAT-90-13 account-session.json serverCases（规则 4，约束假服务端）', () => {
  for (const c of spec.serverCases) {
    it(`${c.name}（${c.rule}）`, () => {
      const s = new FakeAccountSession();
      for (const [i, step] of c.steps.entries()) {
        const at = `${c.name} 第 ${i + 1} 步 ${step.op}`;
        if (step.op === 'advance') s.now += step.ms ?? 0;
        if (step.op === 'access') expect(s.access(step.gen!), at).toBe(step.result);
        if (step.op === 'refresh') {
          for (let n = 0; n < (step.repeat ?? 0); n++) s.refresh(step.gen!);
          if (step.repeat === undefined) {
            const r = s.refresh(step.gen!);
            expect(r.result, at).toBe(step.result);
            if (step.newGen !== undefined) expect(r.newGen, at).toBe(step.newGen);
          }
        }
        expect(s.current, `${at} current`).toBe(step.current);
        expect(s.revoked, `${at} revoked`).toBe(step.revoked);
        expect(s.overlapMinGen, `${at} overlapMinGen`).toBe(step.overlapMinGen);
        expect(s.now < s.overlapUntil, `${at} inWindow`).toBe(step.inWindow);
        expect(s.pendings, `${at} pendings`).toEqual(step.pendings);
      }
    });
  }

  it('SDK 对着假服务端：连续 3 轮刷新并重连，每轮都转正，没有 superseded，没有吊销', async () => {
    const h = accountSetup();
    const srv = new FakeAccountSession();
    h.session(1, 5 * 3_600_000);
    const genOf = (t: string) => Number(t.split('.')[2]);
    h.http.onRequest = (call) => {
      srv.now = h.clock.now();
      const gen = genOf(String(call.json['refreshToken']));
      const r = srv.refresh(gen);
      expect(r.result).toMatch(/^issued/);
      call.respond(200, authBody({ gen: r.newGen!, accessExpiresAt: h.clock.now() + 24 * 3_600_000 }));
    };
    const authed = async () => {
      await flush();
      const conn = h.transport.current;
      conn.open();
      expect(srv.access(lineageOf(String(conn.last('auth').data['token'])).gen)).not.toBe('tokenExpired');
      conn.ack('auth', { userId: USER, serverTime: h.clock.now() });
      await flush();
      conn.ack('convs', { convs: [], truncated: false });
      await flush();
    };
    h.im.connect(h.account.tokenProvider);
    await authed(); // 不足 6 小时：拨号时就开始刷新，换上之后 1000 重连
    for (let round = 0; round < 3; round++) {
      h.clock.advance(18 * 3_600_000 + 60_000); // 不足 6 小时才刷新；刷新回来就不足的不再主动刷新（问题 S1）
      await flush();
      h.account.foreground();
      await authed();
    }
    expect(srv.revoked).toBe(false);
    expect(srv.current).toBe(h.account.localGen);
    expect(h.account.localGen).toBeGreaterThanOrEqual(4);
  });
});
