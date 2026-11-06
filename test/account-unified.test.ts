// 三套 SDK 统一的语义（frontend-chat 问题表 S1、K7、S3、K5，docs/sdk/README.md 第 6 节）。
// sdk-kotlin 的 AccountUnifiedTest、sdk-swift 的 AccountUnifiedTests 是同一组用例。本地单测结果，CI 不运行。
import { afterEach, describe, expect, it } from 'vitest';
import { SessionEndedError, type FatalReason, type SessionEnd } from '../src/index.js';
import { flush } from './helpers.js';
import { HOUR, PASSWORD, REFRESH, USER, accountSetup, authBody, jwt, type AccountHarness } from './support/account.js';

const DAY = 24 * HOUR;
const MIN = 60_000;
const ACK = '/v1/account/recovery-code/ack';
const LOGOUT = '/v1/account/logout';

let current: AccountHarness | null = null;
function setupAccount(): AccountHarness {
  current = accountSetup();
  return current;
}
afterEach(() => {
  expect(current?.badRequests ?? []).toEqual([]);
  current = null;
});

function watch(h: AccountHarness) {
  const fatal: FatalReason[] = [];
  const ended: SessionEnd[] = [];
  const states: string[] = [];
  h.im.on('fatal', (r) => fatal.push(r));
  h.im.on('state', (s) => states.push(s));
  h.account.on('ended', (e) => ended.push(e));
  return { fatal, ended, states };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const authToken = (c: { last(cmd: string): { data: Record<string, unknown> } }) => c.last('auth').data['token'];

/**
 * 假服务端：每次刷新都立刻回一个新的 token，到期时间由 leftMs 决定。
 * 循环全在微任务里（修复前会一直跑到内存耗尽，setImmediate 都轮不到），所以超过 ANSWER_CAP 次就不再应答：
 * 这样用例是断言失败，不是卡死。
 */
const ANSWER_CAP = 50;
function autoRefresh(h: AccountHarness, leftMs: () => number): void {
  const previous = h.http.onRequest;
  let gen = 100;
  h.http.onRequest = (call) => {
    previous?.(call);
    if (call.path === REFRESH && gen - 100 < ANSWER_CAP) {
      gen += 1;
      call.respond(200, authBody({ gen, accessExpiresAt: h.clock.now() + leftMs() }));
    }
  };
}

/** 跑 rounds 轮：连接自动完成 auth，时钟往前走。修复前每轮都多一次刷新，轮数就是上限，不会跑到内存耗尽。 */
async function run(h: AccountHarness, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await flush();
    const c = h.transport.connections.at(-1);
    if (c && !c.closedWith && !c.frames().some((f) => f.cmd === 'auth')) await h.login(USER);
    h.clock.advance(1_000);
  }
  await flush();
}

describe('S1 刷新回来的 token 按本地时钟已不足 6 小时', () => {
  it('TTL 配得短：只刷新一次、重连一次，不循环', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, 5 * HOUR);
    autoRefresh(h, () => 4 * HOUR);
    h.im.connect(h.account.tokenProvider);
    await run(h, 30);
    expect(h.http.to(REFRESH).length).toBe(1);
    expect(h.transport.connections.length).toBe(2);
    expect(h.transport.current.closedWith).toBeNull();
    expect(w.ended).toEqual([]);
  });

  it('本地时钟偏快，启动已过期：先刷新再 auth，新 token 看起来也过期，不循环，也不当成过期', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, -HOUR);
    autoRefresh(h, () => -MIN);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    expect(h.transport.connections.length).toBe(1);
    expect(authToken(await h.login(USER))).toBe(jwt('sid1', 101));
    await run(h, 30);
    expect(h.http.to(REFRESH).length).toBe(1);
    expect(h.transport.connections.length).toBe(1);
    // 断线重连：还是用这个 token，不刷新。
    h.transport.current.drop(1006);
    await run(h, 3);
    expect(h.http.to(REFRESH).length).toBe(1);
    expect(h.transport.connections.length).toBe(2);
    expect(authToken(h.transport.current)).toBe(jwt('sid1', 101));
    expect(w.ended).toEqual([]);
  });

  it('前台和定时器都不再刷新；HTTP 请求带这个 token 直接发', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    autoRefresh(h, () => -MIN);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    h.account.foreground();
    h.account.trigger('timer');
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);

    const events = h.account.listEvents();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    h.http.last('/v1/account/events').respond(200, { events: [], otherSessions: { count: 0 } });
    await events;

    const change = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await change;
  });

  it('服务端的 4011 还是会刷新，一直短也有上限：每个 4011 最多一次', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, 5 * HOUR);
    autoRefresh(h, () => 4 * HOUR);
    h.im.connect(h.account.tokenProvider);
    await run(h, 3);
    expect(h.http.to(REFRESH).length).toBe(1);
    for (let i = 1; i <= 5; i++) {
      h.transport.current.drop(4011);
      await run(h, 40); // 第二次起按退避重连
      expect(h.http.to(REFRESH).length).toBe(1 + i);
    }
    expect(w.ended).toEqual([]);
  });

  it('下一个时间正常的 token 恢复定时刷新', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    let left = 4 * HOUR;
    autoRefresh(h, () => left);
    h.im.connect(h.account.tokenProvider);
    await run(h, 3);
    expect(h.http.to(REFRESH).length).toBe(1);
    left = DAY;
    h.transport.current.drop(4011);
    await run(h, 3);
    expect(h.http.to(REFRESH).length).toBe(2);
    h.clock.advance(18 * HOUR);
    await flush();
    expect(h.http.to(REFRESH).length).toBe(3);
  });

  it('改密换来的 token 不足 6 小时不算"刷新回来的"：可以再刷新一次，然后才停', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    autoRefresh(h, () => 4 * HOUR);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    const change = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid2', gen: 1, accessExpiresAt: h.clock.now() + 4 * HOUR }));
    await change;
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(2);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(2);
  });

  it('重启后判断从头开始：每次启动最多多一次刷新', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    autoRefresh(h, () => 4 * HOUR);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(1);
    h.account.restore(h.account.session!);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(2);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH).length).toBe(2);
  });

  it('绝对上限不受影响：到期回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, 5 * HOUR);
    const at = h.clock.now() + 2 * HOUR;
    h.account.foreground();
    await flush();
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: at, absoluteExpiresAt: at }));
    await flush();
    h.im.connect(h.account.tokenProvider);
    await flush();
    await h.login(USER);
    h.clock.advance(2 * HOUR);
    await flush();
    expect(w.ended.map((e) => e.reason)).toEqual(['expired']);
    expect(h.http.to(REFRESH).length).toBe(1);
  });
});

describe('K7 会话已结束时 connect(tokenProvider)', () => {
  it('没有登录过：发一次 session 类 fatal，不停在连接中，不开连接', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(w.fatal).toEqual([{ kind: 'session', action: 'login' }]);
    expect(h.im.state).toBe('disconnected');
    expect(h.transport.connections.length).toBe(0);
    h.clock.advance(5 * MIN);
    await flush();
    expect(w.fatal.length).toBe(1);
    expect(h.transport.connections.length).toBe(0);
  });

  it('start 的刷新收到 4019 之后才连接：fatal 带这次结束的原因', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, 5 * HOUR);
    h.account.foreground();
    await flush();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'replayDetected' });
    await flush();
    expect(w.ended.length).toBe(1);
    expect(w.fatal).toEqual([]);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(w.fatal).toEqual([
      { kind: 'session', action: 'login', dialog: 'credentialAnomaly', reason: 'replayDetected', code: 4019 },
    ]);
    expect(h.im.state).toBe('disconnected');
  });

  it('踢线结束后才连接：fatal 不带 origin', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged' } });
    c.drop(4012);
    await flush();
    expect(w.fatal.length).toBe(1);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(w.fatal.length).toBe(2);
    expect(w.fatal[1]).toEqual({
      kind: 'session',
      action: 'login',
      dialog: 'accountOffline',
      reason: 'passwordChanged',
      code: 4012,
    });
  });

  it('退出之后才连接：action 是 logout', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const out = h.account.logout();
    await flush();
    h.http.last(LOGOUT).respond(200);
    await out;
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(w.fatal).toEqual([{ kind: 'session', action: 'logout' }]);
  });

  it('等 token 时会话才结束：只有一次 fatal', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, -HOUR);
    h.im.connect(h.account.tokenProvider);
    await flush();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'revoked' });
    await flush();
    expect(w.fatal.length).toBe(1);
    expect(h.im.state).toBe('disconnected');
  });

  it('fatal 之后重新登录再连接：正常连上', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(w.fatal.length).toBe(1);
    const login = h.account.login('alice_1', 'Password-1');
    await flush();
    h.http.last('/v1/account/login').respond(200, authBody({ gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await login;
    h.im.connect(h.account.tokenProvider);
    await flush();
    const c = await h.login(USER);
    expect(authToken(c)).toBe(jwt('sid1', 1));
    expect(h.im.state).toBe('connected');
    expect(w.fatal.length).toBe(1);
  });

  it('SessionEndedError 还能不带参数构造（公开接口只增加可选字段）', () => {
    expect(new SessionEndedError().end).toBeUndefined();
  });
});

describe('S3 存储回调可以挂起', () => {
  it('窗口一：改密响应落盘时退出，响应不把已结束的会话救回来，存储里也不留', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const gate = deferred();
    const change = h.account.changePassword('Password-1', 'Password-2');
    change.catch(() => undefined);
    await flush();
    h.store.saveGate = gate.promise;
    h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    const out = h.account.logout();
    await flush();
    h.http.last(LOGOUT).respond(200);
    await flush();
    gate.resolve();
    h.store.saveGate = null;
    await expect(change).rejects.toBeInstanceOf(SessionEndedError);
    await out;
    await flush();
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();
    expect(w.ended.map((e) => e.action)).toEqual(['logout']);
  });

  it('窗口一：改密响应落盘时开始退出，logout 还没回：响应已经不能采用', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const seen: string[] = [];
    h.account.on('tokens', () => seen.push('tokens'));
    const gate = deferred();
    const change = h.account.changePassword('Password-1', 'Password-2');
    change.catch(() => undefined);
    await flush();
    h.store.saveGate = gate.promise;
    h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    const out = h.account.logout();
    await flush();
    gate.resolve();
    h.store.saveGate = null;
    await expect(change).rejects.toBeInstanceOf(SessionEndedError);
    expect(seen).toEqual([]);
    h.http.last(LOGOUT).respond(200);
    await out;
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();
  });

  it('窗口一：登录响应落盘时被踢，也不救回来', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c = await h.online();
    const gate = deferred();
    const login = h.account.login('alice_1', 'Password-1');
    login.catch(() => undefined);
    await flush();
    h.store.saveGate = gate.promise;
    h.http
      .last('/v1/account/login')
      .respond(200, authBody({ sid: 'sid2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4010);
    await flush();
    expect(h.account.session).toBeNull();
    gate.resolve();
    h.store.saveGate = null;
    await expect(login).rejects.toBeInstanceOf(SessionEndedError);
    await flush();
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();
  });

  it('存储按顺序执行：结束时的清除不会被更早的慢保存超过', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    h.account.foreground();
    await flush();
    const gate = deferred();
    h.store.saveGate = gate.promise;
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    const out = h.account.logout();
    await flush();
    h.http.last(LOGOUT).respond(200);
    await flush();
    gate.resolve();
    h.store.saveGate = null;
    await out;
    await flush();
    expect(h.store.saved).toBeNull();
  });

  async function unacked(h: AccountHarness) {
    h.session(1, DAY);
    const change = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http.last(PASSWORD).respond(
      200,
      authBody({
        sid: 'sid2',
        gen: 1,
        accessExpiresAt: h.clock.now() + DAY,
        recoveryCode: 'CODE',
        recoveryCodeGen: 2,
      }),
    );
    await change;
    expect(h.store.saved).toBeNull();
  }

  it('窗口二：写存储失败，错误给调用方，再确认一次能重写，标记没有提前清', async () => {
    const h = setupAccount();
    await unacked(h);
    h.store.failSave = true;
    const first = h.account.ackRecoveryCode(2);
    await flush();
    h.http.last(ACK).respond(200);
    await expect(first).rejects.toThrow('disk full');
    expect(h.store.saved).toBeNull();
    h.store.failSave = false;
    const second = h.account.ackRecoveryCode(2);
    await flush();
    h.http.last(ACK).respond(200);
    await second;
    expect(h.store.saved?.accessToken).toBe(jwt('sid2', 1));
  });

  it('窗口二：写存储期间刷新换了 token，最后存的是在用的，之后的刷新正常落盘', async () => {
    const h = setupAccount();
    await unacked(h);
    const gate = deferred();
    h.store.saveGate = gate.promise;
    const ack = h.account.ackRecoveryCode(2);
    await flush();
    h.http.last(ACK).respond(200);
    await flush();
    h.clock.advance(18 * HOUR + 1);
    h.account.foreground();
    await flush();
    h.http.last(REFRESH).respond(200, authBody({ sid: 'sid2', gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    gate.resolve();
    h.store.saveGate = null;
    await ack;
    await flush();
    expect(h.account.session?.accessToken).toBe(jwt('sid2', 2));
    expect(h.store.saved?.accessToken).toBe(jwt('sid2', 2));
    h.clock.advance(18 * HOUR + 1);
    h.account.foreground();
    await flush();
    h.http.last(REFRESH).respond(200, authBody({ sid: 'sid2', gen: 3, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.store.saved?.accessToken).toBe(jwt('sid2', 3));
  });

  it('窗口二：写存储期间会话结束，又用恢复码登录：新 token 还是不落盘', async () => {
    const h = setupAccount();
    await unacked(h);
    const gate = deferred();
    h.store.saveGate = gate.promise;
    const ack = h.account.ackRecoveryCode(2);
    await flush();
    h.http.last(ACK).respond(200);
    await flush();
    const out = h.account.logout();
    await flush();
    h.http.last(LOGOUT).respond(200);
    await flush();
    const recover = h.account.recover(USER, 'CODE', 'Password-3');
    await flush();
    h.http.last('/v1/account/recover').respond(
      200,
      authBody({
        sid: 'sid3',
        gen: 1,
        accessExpiresAt: h.clock.now() + DAY,
        recoveryCode: 'NEXT',
        recoveryCodeGen: 3,
      }),
    );
    await flush();
    gate.resolve();
    h.store.saveGate = null;
    await ack;
    await out;
    await recover;
    await flush();
    expect(h.account.session?.accessToken).toBe(jwt('sid3', 1));
    expect(h.store.saved).toBeNull();
  });
});

describe('K5 旧 sid 的踢线', () => {
  it('响应先到踢线后到：旧连接的回调已失效，踢线到不了账号，不回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY, 'sid-old');
    const c1 = await h.online();
    const change = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid-new', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await change;
    await flush();
    expect(h.transport.connections.length).toBe(2);
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged' } });
    c1.drop(4012);
    await flush();
    expect(authToken(await h.login(USER))).toBe(jwt('sid-new', 1));
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([]);
    expect(h.account.session).not.toBeNull();
  });

  // 窗口只有一个微任务：拨号读到旧 token，还没开连接时换了 sid（"token 换了"的通知这时没有连接可断）。对齐哪一拍取决于存储，所以逐拍试。
  it.each([...Array(16).keys()])(
    '拨号读到旧 token 后才换 sid（错开 %i 拍）：旧 sid 被踢不结束会话，用新 token 重连',
    async (ticks) => {
      const h = setupAccount();
      const w = watch(h);
      h.session(1, DAY, 'sid-old');
      const gate = deferred();
      const change = h.account.changePassword('Password-1', 'Password-2');
      await flush();
      h.store.saveGate = gate.promise;
      h.http.last(PASSWORD).respond(200, authBody({ sid: 'sid-new', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
      await flush();
      h.store.saveGate = null;
      gate.resolve();
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      h.im.connect(h.account.tokenProvider);
      await change;
      await flush();
      const c = h.transport.current;
      c.open();
      await flush();
      if (authToken(c) === jwt('sid-old', 1)) {
        c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged' } });
        c.drop(4012);
        await flush();
        h.transport.current.open();
        await flush();
      }
      expect(authToken(h.transport.current)).toBe(jwt('sid-new', 1));
      expect(w.fatal).toEqual([]);
      expect(w.ended).toEqual([]);
      expect(h.account.session).not.toBeNull();
    },
  );

  it('当前 sid 的踢线照常生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY, 'sid-now');
    const c = await h.online();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged' } });
    c.drop(4012);
    await flush();
    expect(w.ended.length).toBe(1);
    expect(h.account.session).toBeNull();
  });
});
