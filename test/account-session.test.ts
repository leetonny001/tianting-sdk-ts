// FE-610：会话语义（PRD-chat F-ACC-03 规则 5～7、F-ACC-04 规则 3、F-ACC-05 规则 1）。
// 假 HTTP + FakeTransport + 假时钟。测试名带 TC-ACC 编号。这些是本地单测结果；界面部分（弹窗、页面）属于 FE-613～618。
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountError,
  AccountTimeoutError,
  SessionEndedError,
  sessionDialogText,
  type FatalReason,
  type SessionEnd,
} from '../src/index.js';
import { flush } from './helpers.js';
import {
  HOUR,
  PASSWORD,
  REFRESH,
  USER,
  accountSetup,
  authBody,
  jwt,
  refreshToken,
  type AccountHarness,
} from './support/account.js';

const DAY = 24 * HOUR;
const MIN = 60_000;

let current: AccountHarness | null = null;
function setupAccount(): AccountHarness {
  current = accountSetup();
  return current;
}
afterEach(() => {
  // 每个用例发出的请求体都符合 http-client.schema.json。
  expect(current?.badRequests ?? []).toEqual([]);
  current = null;
});

function watch(h: AccountHarness) {
  const fatal: FatalReason[] = [];
  const ended: SessionEnd[] = [];
  const banner: boolean[] = [];
  h.im.on('fatal', (r) => fatal.push(r));
  h.im.on('banner', (b) => banner.push(b));
  h.account.on('ended', (e) => ended.push(e));
  return { fatal, ended, banner };
}

const authToken = (c: { last(cmd: string): { data: Record<string, unknown> } }) => c.last('auth').data['token'];

/** 新连接完成 auth。 */
async function authNew(h: AccountHarness) {
  await flush();
  return h.login(USER);
}

describe('TC-ACC-03-10 连接中剩余不足 6 小时（AC-ACC-03-10）', () => {
  it('推进 2 分钟：刷新一次，1000 断开，用新 token 重连，不提示，消息照常收发', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, 6 * HOUR + MIN);
    const c1 = await h.online();
    expect(h.http.to(REFRESH)).toHaveLength(0);
    h.clock.advance(MIN + 1_000); // 2 分钟里的第 1 分 1 秒：不足 6 小时，发出去了
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(h.http.last(REFRESH).json['refreshToken']).toBe(refreshToken('sid1', 1));
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(c1.closedWith).toEqual({ code: 1000, reason: 'token rotated' });
    expect(h.transport.connections).toHaveLength(2);
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid1', 2));
    expect(h.im.state).toBe('connected');
    h.clock.advance(MIN - 1_000); // 2 分钟走完
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(w.banner.filter(Boolean)).toEqual([]);
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([]);
    const sent = h.im.send('c2c:alice_1:bobby', 'hi');
    expect(sent.ok).toBe(true);
    expect(c2.last('send').data).toMatchObject({ to: 'bobby' });
  });

  it('剩余恰好 6 小时不刷新，过这个点才刷新', async () => {
    const h = setupAccount();
    h.session(1, 6 * HOUR + MIN);
    await h.online();
    h.clock.advance(MIN);
    expect(h.http.to(REFRESH)).toHaveLength(0);
    h.clock.advance(1);
    expect(h.http.to(REFRESH)).toHaveLength(1);
  });

  it('没有连接时不用定时器，回前台才检查；新 token 先落盘再使用', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.clock.advance(DAY / 2);
    expect(h.http.to(REFRESH)).toHaveLength(0);
    h.account.foreground();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    let savedBeforeAdopt = false;
    h.account.on('tokens', () => {
      savedBeforeAdopt = h.store.saved?.accessToken === h.account.session?.accessToken;
    });
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(savedBeforeAdopt).toBe(true);
  });

  it('落盘失败时不使用新 token，按退避重试，旧值仍然有效', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    h.store.failSave = true;
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.account.localGen).toBe(1);
    h.store.failSave = false;
    h.clock.advance(1_000);
    expect(h.http.to(REFRESH)).toHaveLength(2);
    expect(h.http.last(REFRESH).json['refreshToken']).toBe(refreshToken('sid1', 1));
  });
});

describe('启动已过期（规则 5，TC-ACC-03-07 的 SDK 部分）', () => {
  it('没发 auth 之前先刷新；不足 1 秒不提示', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, -HOUR);
    h.im.connect(h.account.tokenProvider);
    await flush();
    expect(h.transport.connections).toHaveLength(0);
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    const c = await authNew(h);
    expect(authToken(c)).toBe(jwt('sid1', 2));
    expect(w.fatal).toEqual([]);
  });

  it('start() 从 store 读会话；没有 mode 的老数据按演示模式，不刷新（R-CF-11）', async () => {
    const h = setupAccount();
    h.store.saved = { userId: USER, accessToken: 'old-demo-token', accessExpiresAt: h.clock.now() - HOUR };
    await h.account.start();
    expect(h.account.session?.mode).toBe('demo');
    expect(h.http.calls).toHaveLength(0);
  });
});

describe('TC-ACC-03-12 刷新失败留在当前页、4011 自动重连（AC-ACC-03-12）', () => {
  it('503：退避重试，不回登录页，成功后恢复', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    await h.online();
    h.http.last(REFRESH).respondError(503, 5030);
    await flush();
    expect(w.ended).toEqual([]);
    expect(h.im.state).toBe('connected');
    h.clock.advance(999);
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.clock.advance(1);
    expect(h.http.to(REFRESH)).toHaveLength(2);
    h.http.last(REFRESH).respondError(503, 5030);
    await flush();
    h.clock.advance(1_999);
    expect(h.http.to(REFRESH)).toHaveLength(2);
    h.clock.advance(1);
    expect(h.http.to(REFRESH)).toHaveLength(3);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await authNew(h);
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([]);
  });

  it('代理返回的 HTML（没有错误码）不算服务端判断：退避，不回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    h.account.foreground();
    h.http.last(REFRESH).respond(403, '<html>captive portal</html>');
    await flush();
    expect(w.ended).toEqual([]);
    h.clock.advance(1_000);
    expect(h.http.to(REFRESH)).toHaveLength(2);
  });

  it('kicked/tokenExpired 且刷新成功：不弹窗，自动重连', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c1 = await h.online();
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tokenExpired' } });
    c1.drop(4011, 'tokenExpired');
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1); // 不看剩余时间
    expect(h.transport.connections).toHaveLength(1); // 刷新回来之前不用旧 token 重连
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.transport.connections).toHaveLength(2);
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid1', 2));
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([]);
  });

  it('只有关闭码 4011 没有 kicked 帧：同样走规则 7', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c1 = await h.online();
    c1.drop(4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(w.fatal).toEqual([]);
  });

  it('4011 比较代号：本地比被拒绝的新就直接用本地值重连，不刷新', async () => {
    const h = setupAccount();
    h.session(5, DAY);
    h.im.connect(h.account.tokenProvider);
    await flush();
    const c1 = h.transport.current;
    c1.open();
    // 拨号之后本地换上了更新的代（比如另一个请求刷新过），连接还没换的时候被拒绝。
    h.http.onRequest = null;
    h.account.restore({ ...h.account.session!, accessToken: jwt('sid1', 6), refreshToken: refreshToken('sid1', 6) });
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tokenExpired' } });
    c1.drop(4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(0);
    expect(h.transport.connections).toHaveLength(2);
    h.transport.current.open();
    expect(authToken(h.transport.current)).toBe(jwt('sid1', 6));
  });

  it('本地换过 sid：新 sid 的代号比旧的小也算更新（改密后 gen 从头开始）', async () => {
    const h = setupAccount();
    h.session(9, DAY, 'sid-old');
    h.im.connect(h.account.tokenProvider);
    await flush();
    const c1 = h.transport.current;
    c1.open();
    h.account.restore({
      ...h.account.session!,
      accessToken: jwt('sid-new', 1),
      refreshToken: refreshToken('sid-new', 1),
    });
    c1.drop(4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(0);
    expect(h.transport.connections).toHaveLength(2);
  });

  it('连续被 4011 拒绝：第一次立即重连，之后按退避，不和服务端打转', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    h.http.onRequest = (call) => {
      const gen = Number(String(call.json['refreshToken']).split('.')[2]);
      call.respond(200, authBody({ gen: gen + 1, accessExpiresAt: h.clock.now() + DAY }));
    };
    h.im.connect(h.account.tokenProvider);
    await flush();
    h.transport.current.open();
    h.transport.current.drop(4011);
    await flush();
    expect(h.transport.connections).toHaveLength(2); // 第一次立即
    h.transport.current.open();
    h.transport.current.drop(4011);
    await flush();
    expect(h.transport.connections).toHaveLength(2); // 第二次等退避
    h.clock.advance(1_000);
    await flush();
    expect(h.transport.connections).toHaveLength(3);
  });

  it('演示模式：connect(token) 收到 4011 不重连，不发 HTTP（行为不变）', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.im.connect('demo-token');
    const c = await h.login('demo');
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tokenExpired' } });
    c.drop(4011, 'tokenExpired');
    await flush();
    expect(w.fatal).toEqual([{ kind: 'kicked', reason: 'tokenExpired', code: 4011 }]);
    expect(h.http.calls).toHaveLength(0);
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });

  it('不认识的踢线原因：关闭码可以重连就忽略它；账号模式 4012 按关闭码结束会话', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c1 = await h.online();
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'futureReason' } });
    c1.drop(1006);
    h.clock.advance(1_000);
    await flush();
    expect(h.transport.connections).toHaveLength(2);
    expect(w.fatal).toEqual([]);
    const c2 = await authNew(h);
    c2.receive({ cmd: 'event', data: { type: 'kicked', reason: 'futureReason' } });
    c2.drop(4012);
    await flush();
    expect(w.fatal).toEqual([{ kind: 'kicked', reason: 'futureReason', code: 4012 }]);
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'accountOffline', origin: 'kick' });
    expect(h.account.session).toBeNull();
  });
});

describe('TC-ACC-03-23 四个入口合并成一次，迟到响应丢弃（AC-ACC-03-23）', () => {
  it('启动、回前台、定时器、kicked 同时触发：同一时间 1 个请求；超时后重试；迟到的 R2 被丢弃，保存的是 R3', async () => {
    const h = setupAccount();
    h.session(1, 5 * HOUR);
    await h.account.start();
    h.account.foreground();
    h.account.trigger('timer');
    const c1 = await h.online();
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tokenExpired' } });
    c1.drop(4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(h.account.refreshInflight).toBe(true);

    h.clock.advance(30_000);
    expect(h.account.refreshInflight).toBe(false);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.clock.advance(1_000); // 退避 1 秒
    expect(h.http.to(REFRESH)).toHaveLength(2);
    const [first, second] = h.http.to(REFRESH);

    second!.respond(200, authBody({ gen: 3, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.store.saved?.refreshToken).toBe(refreshToken('sid1', 3));
    const saves = h.store.saves.length;

    first!.respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.account.localGen).toBe(3);
    expect(h.account.session?.refreshToken).toBe(refreshToken('sid1', 3));
    expect(h.store.saved?.refreshToken).toBe(refreshToken('sid1', 3));
    expect(h.store.saves).toHaveLength(saves);
    expect(h.maxPending()).toBeLessThanOrEqual(2); // 第一个被放弃后才发第二个；它的响应还可能迟到
  });

  it('迟到的 4019 不让会话结束', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    h.account.foreground();
    h.clock.advance(30_000);
    await flush();
    h.clock.advance(1_000);
    const [first, second] = h.http.to(REFRESH);
    first!.respondError(401, 4019, { reason: 'revoked' });
    await flush();
    expect(w.ended).toEqual([]);
    expect(h.account.refreshInflight).toBe(true);
    second!.respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.account.localGen).toBe(2);
  });

  it('等待退避期间回前台不提前发请求', () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    h.http.last(REFRESH).fail();
    return flush().then(() => {
      h.account.foreground();
      expect(h.http.to(REFRESH)).toHaveLength(1);
      h.clock.advance(1_000);
      expect(h.http.to(REFRESH)).toHaveLength(2);
    });
  });
});

describe('TC-ACC-03-26 replayDetected（AC-ACC-03-26）', () => {
  it('回登录页前带弹窗文字，本地 token 和存储都清除，连接停止', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    const c = await h.online();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'replayDetected' });
    await flush();
    expect(w.ended).toEqual([{ action: 'login', dialog: 'credentialAnomaly', reason: 'replayDetected', code: 4019 }]);
    expect(sessionDialogText(w.ended[0]!)).toBe('检测到登录凭证异常，这台设备已下线。如果不是你本人操作，请尽快改密码');
    expect(w.fatal).toEqual([
      { kind: 'session', action: 'login', dialog: 'credentialAnomaly', reason: 'replayDetected', code: 4019 },
    ]);
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();
    expect(c.closedWith?.code).toBe(1000);
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });
});

describe('TC-ACC-03-34、TC-ACC-04-24 找回截止日期（AC-ACC-03-34、AC-ACC-04-25 的 SDK 部分）', () => {
  const before = 1_800_518_400_000;

  it('在线或 access 未过期：kicked/passwordChanged 带日期；不重连', async () => {
    for (const reason of ['passwordChanged', 'sessionRevoked', 'accountDeleted']) {
      const h = setupAccount();
      const w = watch(h);
      h.session(1, DAY);
      const c = await h.online();
      c.receive({ cmd: 'event', data: { type: 'kicked', reason, recoverBefore: before } });
      c.drop(4012, reason);
      await flush();
      expect(w.fatal).toEqual([{ kind: 'kicked', reason, code: 4012, recoverBefore: before }]);
      expect(w.ended[0]).toMatchObject({ dialog: 'recoverBefore', recoverBefore: before });
      expect(sessionDialogText(w.ended[0]!, () => '11月13日')).toBe(
        '你的账号凭证有变化。如果不是你本人操作，请在 11月13日 前用恢复码找回',
      );
      h.clock.advance(60_000);
      expect(h.transport.connections).toHaveLength(1);
      expect(h.account.session).toBeNull();
    }
  });

  it('access 已过期：刷新得到 4019 credentialsChanged，同样提示日期，不弹凭证异常（TC-ACC-04-15）', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, -HOUR);
    h.im.connect(h.account.tokenProvider);
    await flush();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'credentialsChanged', details: { recoverBefore: before } });
    await flush();
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'recoverBefore', recoverBefore: before });
    expect(w.fatal[0]).toMatchObject({ kind: 'session', dialog: 'recoverBefore', recoverBefore: before });
    expect(h.transport.connections).toHaveLength(0);
  });

  it('没有日期：按原因显示现有文案', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged' } });
    c.drop(4012);
    await flush();
    expect(sessionDialogText(w.ended[0]!)).toBe('账号已被下线');
  });

  it('TC-ACC-04-05 改密设备以外的设备：tooManyConnections 不结束账号会话，其他踢线结束', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'tooManyConnections' } });
    c.drop(4429);
    await flush();
    expect(w.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'tooManyConnections' });
    expect(h.account.session).not.toBeNull();
  });
});

describe('TC-ACC-03-39 限流（AC-ACC-03-37 的 SDK 部分）', () => {
  it('4290：退避，不回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    h.account.foreground();
    h.http.last(REFRESH).respondError(429, 4290);
    await flush();
    expect(w.ended).toEqual([]);
    h.clock.advance(1_000);
    expect(h.http.to(REFRESH)).toHaveLength(2);
  });
});

describe('TC-ACC-03-41 superseded（AC-ACC-03-39）', () => {
  it('按 retryAfterSeconds 重试，间隔都是 120 秒，第 3 次仍然 superseded 回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    h.account.foreground();
    const superseded = () =>
      h.http.last(REFRESH).respondError(401, 4019, { reason: 'superseded', details: { retryAfterSeconds: 120 } });
    superseded();
    await flush();
    expect(w.ended).toEqual([]);
    h.clock.advance(119_999);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.clock.advance(1);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(2);
    superseded();
    await flush();
    expect(w.ended).toEqual([]);
    h.clock.advance(120_000);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(3);
    superseded();
    await flush();
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'supersededExceeded' });
    h.clock.advance(600_000);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(3);
  });

  it('重试前重读本地最新 token', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'superseded', details: { retryAfterSeconds: 120 } });
    await flush();
    // 另一个进程或者崩溃前写进存储的新值。
    h.store.saved = { ...h.store.saved!, accessToken: jwt('sid1', 7), refreshToken: refreshToken('sid1', 7) };
    h.clock.advance(120_000);
    await flush();
    expect(h.http.last(REFRESH).json['refreshToken']).toBe(refreshToken('sid1', 7));
  });

  it('等 superseded 重试时回前台、kicked 都不提前', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    const c = await h.online();
    h.http.last(REFRESH).respondError(401, 4019, { reason: 'superseded', details: { retryAfterSeconds: 120 } });
    await flush();
    h.account.foreground();
    c.drop(4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
  });

  it('成功后清零：之后 3 次 superseded 才回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    h.account.foreground();
    const superseded = () =>
      h.http.last(REFRESH).respondError(401, 4019, { reason: 'superseded', details: { retryAfterSeconds: 1 } });
    superseded();
    await flush();
    h.clock.advance(1_000);
    await flush();
    superseded();
    await flush();
    h.clock.advance(1_000);
    await flush();
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    h.clock.advance(18 * HOUR + 1); // 刷新回来就不足 6 小时的 token 不再主动刷新（问题 S1）
    h.account.foreground();
    for (let i = 0; i < 2; i++) {
      superseded();
      await flush();
      h.clock.advance(1_000);
      await flush();
    }
    expect(w.ended).toEqual([]);
    superseded();
    await flush();
    expect(w.ended).toHaveLength(1);
  });
});

describe('TC-ACC-03-44 在途请求带旧 token 得到 4011（AC-ACC-03-42）', () => {
  it('3 个请求都用本地新 token 重试成功，没有多发刷新', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const results = [h.account.listEvents(), h.account.listEvents(), h.account.listEvents()];
    await flush();
    const inflight = h.http.pending;
    expect(inflight).toHaveLength(3);
    h.account.restore({ ...h.account.session!, accessToken: jwt('sid1', 2), refreshToken: refreshToken('sid1', 2) });
    for (const c of inflight) c.respondError(401, 4011, { reason: 'tokenSuperseded' });
    await flush();
    const retries = h.http.pending;
    expect(retries).toHaveLength(3);
    for (const c of retries) {
      expect(c.bearer).toBe(jwt('sid1', 2));
      c.respond(200, { events: [], otherSessions: { count: 0 } });
    }
    await expect(Promise.all(results)).resolves.toHaveLength(3);
    expect(h.http.to(REFRESH)).toHaveLength(0);
  });

  it('本地不比它新：3 个 4011 合并成一次刷新，刷新后都重试', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const results = [h.account.listEvents(), h.account.listEvents(), h.account.listEvents()];
    await flush();
    for (const c of h.http.pending) c.respondError(401, 4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    for (const c of h.http.pending) {
      expect(c.bearer).toBe(jwt('sid1', 2));
      c.respond(200, { events: [], otherSessions: { count: 0 } });
    }
    await Promise.all(results);
    expect(h.http.to(REFRESH)).toHaveLength(1);
  });

  it('一直 4011：有上限，把错误交给调用方', async () => {
    const h = setupAccount();
    h.session(5, DAY);
    h.http.onRequest = (call) => {
      if (call.path === REFRESH) {
        const gen = Number(String(call.json['refreshToken']).split('.')[2]);
        call.respond(200, authBody({ gen: gen + 1, accessExpiresAt: h.clock.now() + DAY }));
      } else {
        call.respondError(401, 4011);
      }
    };
    const p = h.account.listEvents();
    p.catch(() => undefined);
    await flush();
    await expect(p).rejects.toMatchObject({ code: 4011 });
    expect(h.http.to('/v1/account/events')).toHaveLength(3);
  });

  it('HTTP 和 WS 共用 token 来源：HTTP 触发的刷新让连接也换 token', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c1 = await h.online();
    const p = h.account.listEvents();
    await flush();
    h.http.last('/v1/account/events').respondError(401, 4011);
    await flush();
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(c1.closedWith?.code).toBe(1000);
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid1', 2));
    h.http.last('/v1/account/events').respond(200, { events: [], otherSessions: { count: 1 } });
    await expect(p).resolves.toMatchObject({ otherSessions: { count: 1 } });
  });

  it('HTTP 4012：会话结束', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const p = h.account.listEvents();
    p.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/events').respondError(401, 4012);
    await flush();
    await expect(p).rejects.toBeInstanceOf(AccountError);
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'sessionExpired', code: 4012 });
  });
});

describe('TC-ACC-03-45 access 到期等于绝对上限（AC-ACC-03-43）', () => {
  async function capped(h: AccountHarness) {
    h.session(1, 7 * HOUR);
    h.account.foreground();
    h.clock.advance(2 * HOUR); // 还有 5 小时
    h.account.foreground();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    const at = h.clock.now() + 5 * HOUR;
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: at, absoluteExpiresAt: at }));
    await flush();
    return at;
  }

  it('不再刷新，不重连；到期后回登录页', async () => {
    const h = setupAccount();
    const w = watch(h);
    await capped(h);
    const c = await h.online();
    h.clock.advance(HOUR);
    h.account.foreground();
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(h.transport.connections).toHaveLength(1);
    expect(c.closedWith).toBeNull();
    expect(w.ended).toEqual([]);
    h.clock.advance(4 * HOUR);
    await flush();
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'sessionExpired' });
    expect(w.fatal[0]).toMatchObject({ kind: 'session', dialog: 'sessionExpired' });
    expect(h.account.session).toBeNull();
    expect(h.http.to(REFRESH)).toHaveLength(1);
  });

  it('没有连接：到期后回前台或拨号都回登录页，不发刷新', async () => {
    const h = setupAccount();
    const w = watch(h);
    await capped(h);
    h.clock.advance(6 * HOUR);
    h.account.foreground();
    expect(w.ended[0]).toMatchObject({ dialog: 'sessionExpired' });
    expect(h.http.to(REFRESH)).toHaveLength(1);
  });
});

describe('TC-ACC-04-05 passwordChanged（AC-ACC-04-5）', () => {
  it('不重连，带日期，本地清空', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged', recoverBefore: 1_800_518_400_000 } });
    c.drop(4012);
    await flush();
    expect(w.fatal).toHaveLength(1);
    expect(h.store.saved).toBeNull();
    h.clock.advance(120_000);
    expect(h.transport.connections).toHaveLength(1);
  });
});

describe('TC-ACC-04-09 退出其他设备（AC-ACC-04-10）', () => {
  it('密码错误：401，没有变化，连接不受影响', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.logoutOthers('wrong');
    p.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/logout-others').respondError(401, 4018);
    await expect(p).rejects.toMatchObject({ code: 4018 });
    expect(c.closedWith).toBeNull();
    expect(w.ended).toEqual([]);
    expect(h.account.localGen).toBe(1);
  });

  it('密码正确：旧 sid 的踢线被缓存后忽略，换新 sid 1 秒内重连，不提示，新 token 落盘', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(4, DAY, 'sid-old');
    const c1 = await h.online();
    const p = h.account.logoutOthers('Password-1');
    await flush();
    c1.receive({ cmd: 'event', data: { type: 'kicked', reason: 'sessionRevoked' } });
    c1.drop(4012);
    await flush();
    expect(w.fatal).toEqual([]);
    expect(h.transport.connections).toHaveLength(1);
    h.clock.advance(500);
    h.http
      .last('/v1/account/logout-others')
      .respond(200, authBody({ sid: 'sid-new', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await p;
    await flush();
    expect(h.transport.connections).toHaveLength(2);
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid-new', 1));
    expect(h.store.saved?.refreshToken).toBe(refreshToken('sid-new', 1));
    h.clock.advance(5_000);
    expect(w.fatal).toEqual([]);
    expect(w.banner.filter(Boolean)).toEqual([]);
  });
});

describe('TC-ACC-04-16 定时刷新和改密串行（AC-ACC-04-17）', () => {
  it('改密进行中定时器到期：不发刷新；改密成功换 token 后也不用再刷新', async () => {
    const h = setupAccount();
    h.session(1, 6 * HOUR + 10_000);
    await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.clock.advance(11_000);
    expect(h.http.to(REFRESH)).toHaveLength(0);
    h.http
      .last(PASSWORD)
      .respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'CODE-2' }));
    await p;
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(0);
    expect(h.maxPending()).toBe(1);
  });

  it('改密失败：排着的刷新接着发', async () => {
    const h = setupAccount();
    h.session(1, 6 * HOUR + 10_000);
    await h.online();
    const p = h.account.changePassword('wrong', 'Password-2');
    p.catch(() => undefined);
    await flush();
    h.clock.advance(11_000);
    h.http.last(PASSWORD).respondError(401, 4018);
    await expect(p).rejects.toMatchObject({ code: 4018 });
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    expect(h.maxPending()).toBe(1);
  });

  it('刷新进行中调用改密：等刷新结束，用新 token 发，顺序固定', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    expect(h.http.to(PASSWORD)).toHaveLength(0);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.http.to(PASSWORD)).toHaveLength(1);
    expect(h.http.last(PASSWORD).bearer).toBe(jwt('sid1', 2));
    h.http
      .last(PASSWORD)
      .respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C' }));
    await p;
    expect(h.maxPending()).toBe(1);
  });

  it('队列内的改密要先刷新：access 已过期时直接在自己的位置刷新，不重新排队，也不等自己', async () => {
    const h = setupAccount();
    h.session(1, -MIN);
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    expect(h.http.calls.map((c) => c.path)).toEqual([REFRESH]);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.http.calls.map((c) => c.path)).toEqual([REFRESH, PASSWORD]);
    expect(h.http.last(PASSWORD).bearer).toBe(jwt('sid1', 2));
    h.http
      .last(PASSWORD)
      .respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C' }));
    await expect(p).resolves.toMatchObject({ recoveryCode: 'C' });
  });

  it('改密收到 4011：在自己的位置刷新后重发一次', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http.last(PASSWORD).respondError(401, 4011);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(1);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.http.to(PASSWORD)).toHaveLength(2);
    h.http
      .last(PASSWORD)
      .respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C' }));
    await p;
  });

  it('队列内的刷新失败（网络）：改密失败，不堵队列，后台按退避继续刷新', async () => {
    const h = setupAccount();
    h.session(1, -MIN);
    const p = h.account.changePassword('Password-1', 'Password-2');
    p.catch(() => undefined);
    await flush();
    h.http.last(REFRESH).fail();
    await expect(p).rejects.toBeInstanceOf(Error);
    expect(h.http.to(PASSWORD)).toHaveLength(0);
    h.clock.advance(1_000);
    await flush();
    expect(h.http.to(REFRESH)).toHaveLength(2);
  });

  it('找回和退出其他设备也进同一个队列', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    const a = h.account.logoutOthers('Password-1');
    const b = h.account.recover(USER, 'CODE', 'Password-2');
    await flush();
    expect(h.http.pending.map((c) => c.path)).toEqual([REFRESH]);
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.http.pending.map((c) => c.path)).toEqual(['/v1/account/logout-others']);
    h.http.pending[0]!.respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await a;
    await flush();
    expect(h.http.pending.map((c) => c.path)).toEqual(['/v1/account/recover']);
    h.http.pending[0]!.respond(
      200,
      authBody({ sid: 's3', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C3' }),
    );
    await b;
    expect(h.maxPending()).toBe(1);
  });
});

describe('TC-ACC-04-25 改密的四种响应时序（AC-ACC-04-27）', () => {
  const newTokens = (h: AccountHarness) =>
    authBody({
      sid: 'sid-new',
      gen: 1,
      accessExpiresAt: h.clock.now() + DAY,
      recoveryCode: 'CODE-2',
      recoveryCodeGen: 2,
    });
  const kick = (c: { receive(f: unknown): void; drop(code: number): void }) => {
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'passwordChanged', recoverBefore: 1_800_518_400_000 } });
    c.drop(4012);
  };
  const FATAL = { kind: 'kicked', reason: 'passwordChanged', code: 4012, recoverBefore: 1_800_518_400_000 };

  /** 确认队列不堵：下一个操作能发出去。 */
  async function queueFree(h: AccountHarness) {
    const before = h.http.calls.length;
    h.account.login(USER, 'Password-2').catch(() => undefined);
    await flush();
    expect(h.http.calls.length).toBe(before + 1);
  }

  it('场景一：响应一直不来：30 秒后提示失败，缓存的踢线生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    p.catch(() => undefined);
    await flush();
    kick(c);
    await flush();
    h.clock.advance(29_999);
    await flush();
    expect(w.fatal).toEqual([]);
    h.clock.advance(1);
    await expect(p).rejects.toBeInstanceOf(AccountTimeoutError);
    await flush();
    expect(w.fatal).toEqual([FATAL]);
    expect(w.ended[0]).toMatchObject({ dialog: 'recoverBefore', origin: 'kick' });
    expect(h.account.session).toBeNull();
    await queueFree(h);
  });

  it('场景二：响应在 31 秒到达：丢弃，不换 token，踢线已经生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    p.catch(() => undefined);
    await flush();
    const call = h.http.last(PASSWORD);
    kick(c);
    h.clock.advance(31_000);
    await flush();
    call.respond(200, newTokens(h));
    await flush();
    await expect(p).rejects.toBeInstanceOf(AccountTimeoutError);
    expect(h.account.session).toBeNull();
    expect(h.account.localGen).toBe(1);
    expect(h.store.saved).toBeNull();
    expect(h.transport.connections).toHaveLength(1);
    expect(w.fatal).toEqual([FATAL]);
    await queueFree(h);
  });

  it('场景三：响应 500，同时收到踢线：提示失败，踢线生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    p.catch(() => undefined);
    await flush();
    kick(c);
    await flush();
    h.http.last(PASSWORD).respondError(500, 5000);
    await expect(p).rejects.toMatchObject({ code: 5000 });
    await flush();
    expect(w.fatal).toEqual([FATAL]);
    await queueFree(h);
  });

  it('场景四：响应先到踢线后到：不弹窗，用新 token 重连，旧 sid 的踢线被忽略', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(3, DAY, 'sid-old');
    const c1 = await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http.last(PASSWORD).respond(200, newTokens(h));
    await expect(p).resolves.toMatchObject({ recoveryCode: 'CODE-2', recoveryCodeGen: 2 });
    await flush();
    expect(c1.closedWith?.code).toBe(1000);
    kick(c1);
    await flush();
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid-new', 1));
    h.clock.advance(5_000);
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([]);
    expect(w.banner.filter(Boolean)).toEqual([]);
    expect(h.transport.connections).toHaveLength(2);
    await queueFree(h);
  });

  it('踢线先到响应后到（真实服务端的顺序）：踢线被缓存，成功后立即重连，不弹窗', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(3, DAY, 'sid-old');
    const c1 = await h.online();
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    kick(c1);
    await flush();
    expect(w.fatal).toEqual([]);
    expect(h.transport.connections).toHaveLength(1);
    h.http.last(PASSWORD).respond(200, newTokens(h));
    await p;
    await flush();
    expect(h.transport.connections).toHaveLength(2);
    const c2 = await authNew(h);
    expect(authToken(c2)).toBe(jwt('sid-new', 1));
    h.clock.advance(5_000);
    expect(w.fatal).toEqual([]);
    expect(w.banner.filter(Boolean)).toEqual([]);
  });

  it('封禁不缓存：改密进行中收到 banned 立即生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    h.account.changePassword('Password-1', 'Password-2').catch(() => undefined);
    await flush();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4012);
    await flush();
    expect(w.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'banned' });
  });

  it('没有改密进行时：同样的踢线立即生效', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    kick(c);
    await flush();
    expect(w.fatal).toEqual([FATAL]);
  });

  it('改密还在队列里没发出去：踢线不缓存', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, HOUR);
    const c = await h.online();
    h.account.changePassword('Password-1', 'Password-2').catch(() => undefined);
    await flush();
    expect(h.http.to(PASSWORD)).toHaveLength(0); // 前面有刷新
    kick(c);
    await flush();
    expect(w.fatal).toEqual([FATAL]);
  });
});

describe('TC-ACC-05-06、TC-ACC-05-18 恢复码确认前 token 只放内存（AC-ACC-05-7、AC-ACC-05-19）', () => {
  it('注册、登录：确认前不落盘，确认后才落盘', async () => {
    const h = setupAccount();
    const p = h.account.register({ username: USER, password: 'Password-1', inviteCode: 'INV' });
    await flush();
    h.http
      .last('/v1/account/register')
      .respond(
        200,
        authBody({ gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'CODE-1', recoveryCodeGen: 1 }),
      );
    await expect(p).resolves.toMatchObject({ userId: USER, recoveryCode: 'CODE-1', recoveryCodeGen: 1 });
    expect(h.account.session).not.toBeNull();
    expect(h.store.saved).toBeNull();
    // 杀掉 App：新实例读不到 token，回登录页。
    expect(h.store.load()).toBeNull();
    const ack = h.account.ackRecoveryCode(1);
    await flush();
    expect(h.http.last('/v1/account/recovery-code/ack').json).toEqual({ gen: 1 });
    h.http.last('/v1/account/recovery-code/ack').respond(200, {});
    await ack;
    expect(h.store.saved?.refreshToken).toBe(refreshToken('sid1', 1));
  });

  it('确认前刷新也不落盘', async () => {
    const h = setupAccount();
    const p = h.account.login(USER, 'Password-1');
    await flush();
    h.http
      .last('/v1/account/login')
      .respond(200, authBody({ gen: 1, accessExpiresAt: h.clock.now() + HOUR, recoveryCode: 'C', recoveryCodeGen: 3 }));
    await p;
    await flush();
    h.account.foreground();
    h.http.last(REFRESH).respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.account.localGen).toBe(2);
    expect(h.store.saved).toBeNull();
    expect(h.store.saves).toEqual([]);
  });

  it('改密响应到达：旧 token 从存储清除，新 token 确认前不落盘（杀 App 后回登录页）', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    expect(h.store.saved).not.toBeNull();
    const p = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    h.http
      .last(PASSWORD)
      .respond(
        200,
        authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C', recoveryCodeGen: 2 }),
      );
    await p;
    expect(h.store.saved).toBeNull();
    expect(h.account.session?.refreshToken).toBe(refreshToken('s2', 1));
  });

  it('恢复码还没确认时退出其他设备：新 token 同样只放内存', async () => {
    const h = setupAccount();
    const login = h.account.login(USER, 'Password-1');
    await flush();
    h.http
      .last('/v1/account/login')
      .respond(200, authBody({ gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C', recoveryCodeGen: 3 }));
    await login;
    await flush();
    const p = h.account.logoutOthers('Password-1');
    await flush();
    h.http
      .last('/v1/account/logout-others')
      .respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY }));
    await p;
    expect(h.account.session?.refreshToken).toBe(refreshToken('s2', 1));
    expect(h.store.saved).toBeNull();
    expect(h.store.saves).toEqual([]);
  });

  it('auth ack 带 recoveryCodeUnacked：App 收到事件', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    let viaIm = 0;
    let viaAccount = 0;
    h.im.on('recoveryCodeUnacked', () => (viaIm += 1));
    h.account.on('recoveryCodeUnacked', () => (viaAccount += 1));
    h.im.connect(h.account.tokenProvider);
    await flush();
    const c = h.transport.current;
    c.open();
    c.ack('auth', { userId: USER, serverTime: h.clock.now(), recoveryCodeUnacked: true });
    await flush();
    expect(viaIm).toBe(1);
    expect(viaAccount).toBe(1);
  });

  it('账号接口的响应带 recoveryCodeUnacked：App 收到事件', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    let n = 0;
    h.account.on('recoveryCodeUnacked', () => (n += 1));
    const p = h.account.listEvents();
    await flush();
    h.http
      .last('/v1/account/events')
      .respond(200, { events: [], otherSessions: { count: 0 }, recoveryCodeUnacked: true });
    await p;
    expect(n).toBe(1);
  });

  it('重新生成恢复码：响应只有恢复码（RecoveryCodeResponse），token 不变', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const p = h.account.regenerateRecoveryCode('Password-1');
    await flush();
    h.http.last('/v1/account/recovery-code').respond(200, { recoveryCode: 'NEW', recoveryCodeGen: 5 });
    await expect(p).resolves.toEqual({ recoveryCode: 'NEW', recoveryCodeGen: 5 });
    expect(h.account.localGen).toBe(1);
  });
});

describe('TC-ACC-05-14 recoveryCodeStale（AC-ACC-05-15）', () => {
  it('提示后回登录页，不算确认，token 不落盘', async () => {
    const h = setupAccount();
    const w = watch(h);
    const login = h.account.login(USER, 'Password-1');
    await flush();
    h.http
      .last('/v1/account/login')
      .respond(200, authBody({ gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'C', recoveryCodeGen: 1 }));
    await login;
    const ack = h.account.ackRecoveryCode(1);
    ack.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/recovery-code/ack').respondError(400, 4000, { reason: 'recoveryCodeStale' });
    await expect(ack).rejects.toMatchObject({ code: 4000, reason: 'recoveryCodeStale' });
    expect(w.ended[0]).toMatchObject({ action: 'login', dialog: 'recoveryCodeStale' });
    expect(sessionDialogText(w.ended[0]!)).toBe('恢复码已更新，请重新登录查看');
    expect(h.store.saved).toBeNull();
  });
});

describe('TC-ACC-06-05 改昵称（AC-ACC-06-5）', () => {
  it('本端立即显示；其他端 SDK 钟推进 10 分钟后重新查询', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c = await h.online();
    const changed: string[] = [];
    h.im.on('profileChanged', (id) => changed.push(id));
    const p = h.account.updateProfile({ nickname: '小明' });
    await flush();
    expect(h.http.last('/v1/account/profile').json).toEqual({ nickname: '小明' });
    h.http.last('/v1/account/profile').respond(200, {});
    await p;
    expect(changed).toEqual([USER]);
    expect(h.im.displayName(USER)).toBe('小明');

    // 其他端：缓存 10 分钟（F-SOC-10）。
    const q = h.im.getUsers(['bobby']);
    await flush();
    c.ack('users', { users: [{ userId: 'bobby', nickname: '旧名' }] });
    await q;
    void h.im.getUsers(['bobby']);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'users')).toHaveLength(1);
    h.clock.advance(10 * MIN);
    void h.im.getUsers(['bobby']);
    await flush();
    expect(c.frames().filter((f) => f.cmd === 'users')).toHaveLength(2);
  });
});

describe('TC-ACC-02-13 securityNotice（AC-ACC-02-13 的 SDK 部分）', () => {
  it('新设备登录：事件发给 App；不认识的 kind 忽略', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c = await h.online();
    const got: unknown[] = [];
    h.im.on('securityNotice', (n) => got.push(n));
    c.receive({ cmd: 'event', data: { type: 'securityNotice', kind: 'newDeviceLogin', at: 123, platform: 'ios' } });
    c.receive({ cmd: 'event', data: { type: 'securityNotice', kind: 'somethingNew', at: 124, platform: 'ios' } });
    await flush();
    expect(got).toEqual([{ kind: 'newDeviceLogin', at: 123, platform: 'ios' }]);
    expect(h.logs.filter((l) => l.includes('listener error'))).toEqual([]);
  });

  it('服务端发的四种 kind 都放行（AC-ACC-03-25、AC-ACC-03-45，F-ACC-05 规则 5）', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c = await h.online();
    const got: string[] = [];
    h.im.on('securityNotice', (n) => got.push(n.kind));
    const kinds = ['newDeviceLogin', 'recoveryCodeRegenerated', 'refreshReplay', 'refreshRateLimited'];
    for (const kind of [...kinds, 'newIpPrefix', '']) {
      c.receive({ cmd: 'event', data: { type: 'securityNotice', kind, at: 1, platform: 'ios' } });
    }
    await flush();
    expect(got).toEqual(kinds);
  });
});

describe('TC-ACC-09-01 邀请码用完（AC-ACC-09-1 的 SDK 部分）', () => {
  it('第三个注册 403：错误码和 reason 交给 App，不产生会话', async () => {
    const h = setupAccount();
    const p = h.account.register({ username: 'carol_1', password: 'Password-1', inviteCode: 'INV' });
    p.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/register').respondError(403, 4030, { reason: 'inviteInvalid' });
    await expect(p).rejects.toMatchObject({ status: 403, code: 4030, reason: 'inviteInvalid' });
    expect(h.account.session).toBeNull();
  });
});

describe('F-ACC-04 规则 1 退出', () => {
  it('先通知服务端，再 1000 断开；期间的踢线不算', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.logout();
    await flush();
    const call = h.http.last('/v1/account/logout');
    expect(call.json).toEqual({ refreshToken: refreshToken('sid1', 1) });
    expect(call.bearer).toBe(jwt('sid1', 1));
    expect(c.closedWith).toBeNull();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'sessionRevoked' } });
    c.drop(4012);
    await flush();
    expect(w.fatal).toEqual([]);
    call.respond(200, {});
    await expect(p).resolves.toBe(true);
    await flush();
    expect(w.fatal).toEqual([]);
    expect(w.ended).toEqual([{ action: 'logout' }]);
    expect(h.store.saved).toBeNull();
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });

  it('连接正常时 logout 成功后以 1000 断开', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const c = await h.online();
    const p = h.account.logout();
    await flush();
    h.http.last('/v1/account/logout').respond(200, {});
    await p;
    expect(c.closedWith?.code).toBe(1000);
  });

  it('网络不通：仍然本地退出', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const p = h.account.logout();
    await flush();
    h.http.last('/v1/account/logout').fail();
    await expect(p).resolves.toBe(false);
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();
  });

  it('退出后迟到的刷新响应、改密响应都救不回会话', async () => {
    const h = setupAccount();
    h.session(1, HOUR);
    h.account.foreground();
    const refresh = h.http.last(REFRESH);
    const p = h.account.logout();
    await flush();
    h.http.last('/v1/account/logout').respond(200, {});
    await p;
    refresh.respond(200, authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY }));
    await flush();
    expect(h.account.session).toBeNull();
    expect(h.store.saved).toBeNull();

    const h2 = setupAccount();
    h2.session(1, DAY);
    const change = h2.account.changePassword('Password-1', 'Password-2');
    change.catch(() => undefined);
    await flush();
    const pw = h2.http.last(PASSWORD);
    const out = h2.account.logout();
    await flush();
    h2.http.last('/v1/account/logout').respond(200, {});
    await out;
    pw.respond(200, authBody({ sid: 's2', gen: 1, accessExpiresAt: h2.clock.now() + DAY, recoveryCode: 'C' }));
    await expect(change).rejects.toBeInstanceOf(SessionEndedError);
    expect(h2.account.session).toBeNull();
  });

  it('没有会话时调账号接口：SessionEndedError，不发请求', async () => {
    const h = setupAccount();
    await expect(h.account.listEvents()).rejects.toBeInstanceOf(SessionEndedError);
    await expect(h.account.changePassword('a', 'b')).rejects.toBeInstanceOf(SessionEndedError);
    expect(h.http.calls).toHaveLength(0);
  });
});

describe('F-ACC-08 注销', () => {
  it('申请成功：会话结束，踢线不重复通知；密码错误：无变化', async () => {
    const h = setupAccount();
    const w = watch(h);
    h.session(1, DAY);
    const c = await h.online();
    const wrong = h.account.requestDelete('wrong');
    wrong.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/delete').respondError(401, 4018);
    await expect(wrong).rejects.toMatchObject({ code: 4018 });
    expect(c.closedWith).toBeNull();

    const ok = h.account.requestDelete('Password-1');
    await flush();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'accountDeleted' } });
    c.drop(4012);
    await flush();
    expect(w.fatal).toEqual([]);
    h.http.last('/v1/account/delete').respond(200, {});
    await ok;
    await flush();
    expect(w.fatal).toHaveLength(1);
    expect(h.account.session).toBeNull();
    expect(h.transport.connections).toHaveLength(1);
  });

  it('冷静期登录 403 带 deleteAt；撤销是匿名接口', async () => {
    const h = setupAccount();
    const p = h.account.login(USER, 'Password-1');
    p.catch(() => undefined);
    await flush();
    h.http.last('/v1/account/login').respondError(403, 4030, {
      reason: 'accountDeletionPending',
      details: { deleteAt: 123 },
    });
    await expect(p).rejects.toMatchObject({ reason: 'accountDeletionPending', details: { deleteAt: 123 } });
    const c = h.account.cancelDelete(USER, 'Password-1');
    await flush();
    expect(h.http.last('/v1/account/delete/cancel').bearer).toBeUndefined();
    h.http.last('/v1/account/delete/cancel').respond(200, {});
    await c;
  });
});

describe('HTTP 的基础约定（第 4.2、13.1 节）', () => {
  it('超时走注入的 Clock，30 秒', async () => {
    const h = setupAccount();
    const p = h.account.getConfig();
    p.catch(() => undefined);
    h.clock.advance(29_999);
    await flush();
    expect(h.http.pending).toHaveLength(1);
    h.clock.advance(1);
    await expect(p).rejects.toBeInstanceOf(AccountTimeoutError);
  });

  it('getConfig 不带 Bearer；响应原样返回', async () => {
    const h = setupAccount();
    h.session(1, DAY);
    const p = h.account.getConfig();
    await flush();
    const cfg = {
      registerMode: 'invite',
      demoLogin: false,
      features: { files: false },
      limits: {
        usernameMinLen: 4,
        usernameMaxLen: 32,
        passwordMinLen: 8,
        passwordMaxLen: 128,
        nicknameMaxLen: 32,
        deviceNameMaxLen: 64,
      },
    };
    expect(h.http.last('/v1/config').bearer).toBeUndefined();
    h.http.last('/v1/config').respond(200, cfg);
    await expect(p).resolves.toEqual(cfg);
  });

  it('token、refresh、恢复码、密码不进 URL、日志、事件和错误信息', async () => {
    const h = setupAccount();
    const secrets = new Set<string>(['Password-1', 'Password-2', 'CODE-SECRET', 'CODE-SECRET-2', 'INV-SECRET']);
    const seenEvents: string[] = [];
    h.account.on('outcome', (o) => seenEvents.push(JSON.stringify(o)));
    h.account.on('ended', (e) => seenEvents.push(JSON.stringify(e)));
    h.im.on('fatal', (r) => seenEvents.push(JSON.stringify(r)));
    const errors: string[] = [];
    const remember = (e: unknown) => errors.push(String(e), (e as Error).stack ?? '');

    const reg = h.account.register({ username: USER, password: 'Password-1', inviteCode: 'INV-SECRET' });
    await flush();
    let body = authBody({
      gen: 1,
      accessExpiresAt: h.clock.now() + HOUR,
      recoveryCode: 'CODE-SECRET',
      recoveryCodeGen: 1,
    });
    secrets.add(String(body['accessToken'])).add(String(body['refreshToken']));
    h.http.last('/v1/account/register').respond(200, body);
    await reg;
    const c1 = await h.online();
    await flush();
    body = authBody({ gen: 2, accessExpiresAt: h.clock.now() + DAY });
    secrets.add(String(body['accessToken'])).add(String(body['refreshToken']));
    h.http.last(REFRESH).respond(200, body);
    await flush();
    await authNew(h);
    expect(c1.closedWith?.code).toBe(1000);

    const wrong = h.account.changePassword('Password-1', 'Password-2');
    wrong.catch(remember);
    await flush();
    h.http.last(PASSWORD).respondError(401, 4018);
    await flush();
    const pw = h.account.changePassword('Password-1', 'Password-2');
    await flush();
    body = authBody({ sid: 's2', gen: 1, accessExpiresAt: h.clock.now() + DAY, recoveryCode: 'CODE-SECRET-2' });
    secrets.add(String(body['accessToken'])).add(String(body['refreshToken']));
    h.http.last(PASSWORD).respond(200, body);
    await pw;
    await flush();
    await authNew(h);

    const failing = h.account.logoutOthers('Password-1');
    failing.catch(remember);
    await flush();
    h.http.pending[0]!.fail(`fetch failed https://im.test/?token=${String(body['accessToken'])}`);
    await flush();

    h.account.foreground();
    const lg = h.account.logout();
    await flush();
    h.http.last('/v1/account/logout').fail();
    await lg;

    expect(h.logs.length).toBeGreaterThan(0);
    const urls = h.http.calls.map((c) => c.req.url).concat(h.transport.connections.map((c) => c.url));
    const haystacks = { logs: h.logs, urls, events: seenEvents, errors };
    for (const [name, lines] of Object.entries(haystacks)) {
      for (const line of lines) {
        for (const s of secrets) expect(line.includes(s), `${name} 里有凭证: ${line.slice(0, 60)}`).toBe(false);
        expect(line.includes('Bearer'), `${name} 里有 Bearer`).toBe(false);
      }
    }
    expect(h.http.calls.every((c) => new URL(c.req.url).search === '')).toBe(true);
  });
});
