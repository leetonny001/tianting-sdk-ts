// FE-610：SDK 对真实 im-server（测试模式，SQLite，随机端口）。真实的 HTTP、WebSocket 和时钟。
// 重叠窗口配成 61 秒（配置下限是 60 秒，见 server config.go）：superseded 到重放这一段真的要等一个窗口。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountClient,
  AccountError,
  IMClient,
  c2cConvId,
  lineageOf,
  sessionDialogText,
  type AccountSession,
  type FatalReason,
  type SecurityNotice,
  type SessionEnd,
  type SessionStore,
} from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

const PASSWORD = 'Tt-good-pass-2026!';
const NEW_PASSWORD = 'Tt-new-pass-2026!';

let srv: RunningServer;
const ims: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer({ IM_REGISTER_MODE: 'invite', IM_REFRESH_OVERLAP: '61s' });
});
afterAll(async () => {
  for (const im of ims) im.destroy();
  await srv?.stop();
});

async function until<T>(fn: () => T | undefined | false, what: string, timeout = 8_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

class Store implements SessionStore {
  saved: AccountSession | null = null;
  load = () => this.saved;
  save = (s: AccountSession) => {
    this.saved = s;
  };
  clear = () => {
    this.saved = null;
  };
}

interface Device {
  account: AccountClient;
  store: Store;
  im: IMClient;
  fatal: FatalReason[];
  ended: SessionEnd[];
  banner: boolean[];
  logs: string[];
  connect(): Promise<void>;
}

function device(platform: 'web' | 'ios' = 'web'): Device {
  const store = new Store();
  const logs: string[] = [];
  const logger = {
    debug: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  const account = new AccountClient({ baseUrl: srv.httpURL, platform, store, logger });
  const im = new IMClient({ url: srv.wsURL, platform, browserEvents: false, logger });
  ims.push(im);
  const d: Device = {
    account,
    store,
    im,
    fatal: [],
    ended: [],
    banner: [],
    logs,
    async connect() {
      im.connect(account.tokenProvider);
      await until(() => im.state === 'connected', 'connected');
    },
  };
  im.on('fatal', (f) => d.fatal.push(f));
  im.on('banner', (b) => d.banner.push(b));
  account.on('ended', (e) => d.ended.push(e));
  return d;
}

async function invite(maxUses: number): Promise<{ code: string; id: string }> {
  const r = await srv.signed('POST', '/admin/invites', { count: 1, maxUses, expiresAt: Date.now() + 86_400_000 });
  const inv = (r['invites'] as Array<{ code: string; inviteId: string }>)[0]!;
  return { code: inv.code, id: inv.inviteId };
}

let serial = 0;
/** 注册并确认恢复码。返回用户名和恢复码。 */
async function newUser(d: Device): Promise<{ username: string; recoveryCode: string }> {
  serial += 1;
  const username = `user_${Date.now().toString(36)}${serial}`;
  const { code } = await invite(1);
  const r = await d.account.register({ username, password: PASSWORD, inviteCode: code });
  expect(r.recoveryCode).toBeTruthy();
  expect(d.store.saved).toBeNull(); // 确认前不落盘
  await d.account.ackRecoveryCode(r.recoveryCodeGen!);
  expect(d.store.saved?.mode).toBe('account');
  return { username, recoveryCode: r.recoveryCode! };
}

describe('真实服务端：注册、登录、配置', () => {
  it('getConfig；邀请码 maxUses=2：前两个成功，第三个 403，后台已用 2 次（TC-ACC-09-01）', async () => {
    const d = device();
    const cfg = await d.account.getConfig();
    expect(cfg.registerMode).toBe('invite');
    expect(cfg.limits.passwordMinLen).toBeGreaterThan(0);
    const { code, id } = await invite(2);
    const stamp = Date.now().toString(36);
    for (const n of [1, 2]) {
      const r = await device().account.register({ username: `inv_${stamp}${n}`, password: PASSWORD, inviteCode: code });
      expect(r.recoveryCode).toBeTruthy();
    }
    const third = await d.account
      .register({ username: `inv_${stamp}3`, password: PASSWORD, inviteCode: code })
      .catch((e: unknown) => e);
    expect(third).toBeInstanceOf(AccountError);
    expect(third).toMatchObject({ status: 403, code: 4030, reason: 'inviteInvalid' });
    expect(d.account.session).toBeNull();
    const list = await srv.signed('GET', '/admin/invites');
    const row = (list['invites'] as Array<{ inviteId: string; usedCount: number }>).find((i) => i.inviteId === id);
    expect(row?.usedCount).toBe(2);
  });

  it('密码错误 4018；用户名被占 4095；recoveryCodeStale（TC-ACC-05-14）', async () => {
    const d = device();
    const { username } = await newUser(d);
    await expect(device().account.login(username, 'wrong-password-1')).rejects.toMatchObject({
      status: 401,
      code: 4018,
    });
    const { code } = await invite(1);
    await expect(device().account.register({ username, password: PASSWORD, inviteCode: code })).rejects.toMatchObject({
      status: 409,
      code: 4095,
    });

    const d1 = device();
    await d1.account.login(username, PASSWORD);
    const regenerated = await d1.account.regenerateRecoveryCode(PASSWORD);
    const again = await d1.account.regenerateRecoveryCode(PASSWORD);
    expect(again.recoveryCodeGen).toBeGreaterThan(regenerated.recoveryCodeGen);
    await expect(d1.account.ackRecoveryCode(regenerated.recoveryCodeGen)).rejects.toMatchObject({
      status: 400,
      code: 4000,
      reason: 'recoveryCodeStale',
    });
    expect(d1.ended[0]).toMatchObject({ dialog: 'recoveryCodeStale' });
    expect(d1.account.session).toBeNull();
  });

  it('新设备登录：在线设备收到 securityNotice，账号安全有记录（TC-ACC-02-13）', async () => {
    const d1 = device();
    const { username } = await newUser(d1);
    await d1.connect();
    const notices: SecurityNotice[] = [];
    d1.im.on('securityNotice', (n) => notices.push(n));
    const started = Date.now();
    const d2 = device('ios');
    await d2.account.login(username, PASSWORD);
    await until(() => notices.length > 0, 'securityNotice', 2_000);
    expect(Date.now() - started).toBeLessThan(2_000 + 500);
    expect(notices[0]).toMatchObject({ kind: 'newDeviceLogin', platform: 'ios' });
    const events = await d1.account.listEvents();
    expect(events.otherSessions.count).toBeGreaterThanOrEqual(1);
    expect(events.events.length).toBeGreaterThan(0);
  });
});

describe('真实服务端：刷新', () => {
  it('刷新后 1000 重连，用新一代，消息照常收发，不提示（TC-ACC-03-10）', async () => {
    const d = device();
    const { username } = await newUser(d);
    const peer = device();
    const { username: peerName } = await newUser(peer);
    await peer.connect();
    await d.connect();
    const before = lineageOf(d.account.session!.accessToken);
    await d.account.refresh();
    const after = lineageOf(d.account.session!.accessToken);
    expect(after.sid).toBe(before.sid);
    expect(after.gen).toBeGreaterThan(before.gen);
    expect(d.store.saved?.accessToken).toBe(d.account.session?.accessToken);
    await until(() => d.im.state === 'connected', 'reconnected');
    await new Promise((r) => setTimeout(r, 1_200));
    expect(d.banner.filter(Boolean)).toEqual([]);
    expect(d.fatal).toEqual([]);

    // 真实服务端上 HTTP 也接受新一代（转正之后），WS 收发正常。
    await expect(d.account.listEvents()).resolves.toBeTruthy();
    const conv = c2cConvId(username, peerName);
    expect(d.im.send(conv, 'after rotate').ok).toBe(true);
    await until(() => peer.im.messages(conv).some((m) => m.body.text === 'after rotate'), 'peer receives');
    await d.account.refresh();
    await until(() => d.im.state === 'connected', 'reconnected again');
    await expect(d.account.listEvents()).resolves.toBeTruthy();
    expect(d.ended).toEqual([]);
  });

  it('攻击者转正：在线受害者收到 4011，不比本地新，刷新得到 superseded，窗口后 replayDetected（规则 4、6、7）', async () => {
    const victim = device();
    await newUser(victim);
    await victim.connect();
    const stolen = victim.account.session!.refreshToken!;
    // 攻击者用偷来的 refresh 刷新，并用新 access 转正（标准 fetch，不经过 SDK）。
    const res = await fetch(`${srv.httpURL}/v1/account/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: stolen }),
    });
    expect(res.status).toBe(200);
    const stolenAuth = (await res.json()) as { accessToken: string };
    const events = await fetch(`${srv.httpURL}/v1/account/events`, {
      headers: { Authorization: `Bearer ${stolenAuth.accessToken}` },
    });
    expect(events.status).toBe(200);
    await until(() => victim.ended.length > 0, 'victim ended', 75_000);
    expect(victim.ended[0]).toMatchObject({
      action: 'login',
      dialog: 'credentialAnomaly',
      reason: 'replayDetected',
      code: 4019,
    });
    expect(sessionDialogText(victim.ended[0]!)).toContain('检测到登录凭证异常');
    expect(victim.fatal[0]).toMatchObject({ kind: 'session', dialog: 'credentialAnomaly' });
    expect(victim.logs.some((l) => l.includes('superseded'))).toBe(true);
    expect(victim.store.saved).toBeNull();
    expect(victim.im.state).toBe('disconnected');
  }, 90_000);

  it('access 被替换后 HTTP 收到 4011 tokenSuperseded：用本地新值重试（TC-ACC-03-44 的真实版本）', async () => {
    const d = device();
    await newUser(d);
    const old = d.account.session!.accessToken;
    await d.account.refresh();
    await expect(d.account.listEvents()).resolves.toBeTruthy(); // 新一代转正，旧 access 从此被拒绝
    const raw = await fetch(`${srv.httpURL}/v1/account/events`, { headers: { Authorization: `Bearer ${old}` } });
    expect(raw.status).toBe(401);
    expect(await raw.json()).toMatchObject({ code: 4011, reason: 'tokenSuperseded' });
    expect(d.account.http4011(lineageOf(old))).toEqual({ action: 'useLocal' });
  });

  it('access 已过期的冷启动：先刷新再 auth（用已保存的过期时间模拟本地过期）', async () => {
    const d = device();
    await newUser(d);
    const saved = d.account.session!;
    const d2 = device();
    d2.account.restore({ ...saved, accessExpiresAt: Date.now() - 1_000 });
    await d2.connect();
    expect(lineageOf(d2.account.session!.accessToken).gen).toBeGreaterThan(lineageOf(saved.accessToken).gen);
    expect(d2.fatal).toEqual([]);
  });
});

describe('真实服务端：改密、退出其他设备、找回、退出、注销', () => {
  it('改密：当前设备换 sid 重连不提示；其他设备 passwordChanged 带日期；旧 refresh credentialsChanged（TC-ACC-04-02、03-34）', async () => {
    const d1 = device();
    const { username } = await newUser(d1);
    const d2 = device('ios');
    await d2.account.login(username, PASSWORD);
    await d1.connect();
    await d2.connect();
    const oldRefresh = d1.account.session!.refreshToken!;
    const oldSid = lineageOf(d1.account.session!.accessToken).sid;

    await expect(d1.account.changePassword('wrong-password-1', NEW_PASSWORD)).rejects.toMatchObject({ code: 4018 });
    expect(d1.fatal).toEqual([]);

    const started = Date.now();
    const r = await d1.account.changePassword(PASSWORD, NEW_PASSWORD);
    expect(r.recoveryCode).toBeTruthy();
    await until(() => d1.im.state === 'connected', 'd1 reconnected', 1_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(lineageOf(d1.account.session!.accessToken).sid).not.toBe(oldSid);
    expect(d1.store.saved).toBeNull(); // 确认恢复码之前不落盘
    await new Promise((res) => setTimeout(res, 1_200));
    expect(d1.fatal).toEqual([]);
    expect(d1.ended).toEqual([]);
    expect(d1.banner.filter(Boolean)).toEqual([]);

    await until(() => d2.fatal.length > 0, 'd2 kicked');
    expect(d2.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'passwordChanged', code: 4012 });
    const f = d2.fatal[0] as { recoverBefore?: number };
    expect(f.recoverBefore).toBeGreaterThan(Date.now());
    expect(d2.ended[0]).toMatchObject({ dialog: 'recoverBefore', recoverBefore: f.recoverBefore });
    expect(d2.account.session).toBeNull();

    // 响应丢失的那台设备：用旧 refresh 刷新，不算重放（TC-ACC-04-15）。
    const lost = device();
    lost.account.restore({ ...d1.account.session!, refreshToken: oldRefresh });
    await expect(lost.account.refresh()).rejects.toBeTruthy();
    expect(lost.ended[0]).toMatchObject({
      action: 'login',
      dialog: 'recoverBefore',
      reason: 'credentialsChanged',
      code: 4019,
    });

    await d1.account.ackRecoveryCode(r.recoveryCodeGen!);
    expect(d1.store.saved?.accessToken).toBe(d1.account.session?.accessToken);
    await expect(device().account.login(username, NEW_PASSWORD)).resolves.toMatchObject({ userId: username });
  });

  it('离线设备 access 未过期，别的设备改密后上线：kicked/passwordChanged 带日期，不重连（TC-ACC-03-34）', async () => {
    const d1 = device();
    const { username } = await newUser(d1);
    const offline = device('ios');
    await offline.account.login(username, PASSWORD);
    await d1.account.changePassword(PASSWORD, NEW_PASSWORD);
    offline.im.connect(offline.account.tokenProvider);
    await until(() => offline.fatal.length > 0, 'offline device kicked');
    expect(offline.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'passwordChanged', code: 4012 });
    expect((offline.fatal[0] as { recoverBefore?: number }).recoverBefore).toBeGreaterThan(Date.now());
    expect(offline.ended[0]).toMatchObject({ dialog: 'recoverBefore' });
    await new Promise((res) => setTimeout(res, 1_200));
    expect(offline.im.state).toBe('disconnected');
  });

  it('退出其他设备：密码错 4018；正确时 D2 sessionRevoked，D1 换 sid 重连（TC-ACC-04-09）', async () => {
    const d1 = device();
    const { username } = await newUser(d1);
    const d2 = device('ios');
    await d2.account.login(username, PASSWORD);
    await d1.connect();
    await d2.connect();
    const sid = lineageOf(d1.account.session!.accessToken).sid;
    await expect(d1.account.logoutOthers('wrong-password-1')).rejects.toMatchObject({ code: 4018 });
    expect(d2.fatal).toEqual([]);
    await d1.account.logoutOthers(PASSWORD);
    await until(() => d1.im.state === 'connected', 'd1 reconnected', 1_000);
    expect(lineageOf(d1.account.session!.accessToken).sid).not.toBe(sid);
    expect(d1.store.saved?.accessToken).toBe(d1.account.session?.accessToken);
    await until(() => d2.fatal.length > 0, 'd2 kicked');
    expect(d2.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'sessionRevoked', code: 4012 });
    await new Promise((res) => setTimeout(res, 1_200));
    expect(d1.fatal).toEqual([]);
    expect(d1.banner.filter(Boolean)).toEqual([]);
    await expect(d1.account.listEvents()).resolves.toBeTruthy();
  });

  it('找回：新密码可用，旧设备被踢，新恢复码（TC-ACC-05-05）', async () => {
    const d1 = device();
    const { username, recoveryCode } = await newUser(d1);
    await d1.connect();
    const lost = device('ios');
    const r = await lost.account.recover(username, recoveryCode, NEW_PASSWORD);
    expect(r.recoveryCode).toBeTruthy();
    expect(r.recoveryCode).not.toBe(recoveryCode);
    await until(() => d1.fatal.length > 0, 'old device kicked');
    expect(d1.fatal[0]).toMatchObject({ kind: 'kicked', reason: 'passwordChanged' });
    await lost.account.ackRecoveryCode(r.recoveryCodeGen!);
    await expect(device().account.login(username, NEW_PASSWORD)).resolves.toMatchObject({ userId: username });
    await expect(device().account.login(username, PASSWORD)).rejects.toMatchObject({ code: 4018 });
    await expect(device().account.recover(username, recoveryCode, PASSWORD)).rejects.toMatchObject({ code: 4018 });
  });

  it('改昵称：本端立即显示，对方查询拿到新昵称（TC-ACC-06-05 的服务端部分）', async () => {
    const d = device();
    const { username } = await newUser(d);
    const peer = device();
    const { username: peerName } = await newUser(peer);
    await srv.admin('POST', '/admin/groups', {
      groupId: `g${Date.now().toString(36)}`,
      name: '测试群',
      members: [username, peerName],
    }); // 同群才能查到对方资料
    await peer.connect();
    await d.connect();
    await d.account.updateProfile({ nickname: '小明' });
    expect(d.im.displayName(username)).toBe('小明');
    const [u] = await peer.im.getUsers([username]);
    expect(u?.nickname).toBe('小明');
  });

  it('退出：refresh 失效，连接 1000 断开，不当成被踢（TC-ACC-04-01 的 SDK 部分）', async () => {
    const d = device();
    await newUser(d);
    await d.connect();
    const refreshToken = d.account.session!.refreshToken!;
    await expect(d.account.logout()).resolves.toBe(true);
    await until(() => d.im.state === 'disconnected', 'disconnected');
    expect(d.fatal).toEqual([]);
    expect(d.ended).toEqual([{ action: 'logout' }]);
    expect(d.store.saved).toBeNull();
    const again = await fetch(`${srv.httpURL}/v1/account/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: 4019, reason: 'revoked' });
  });

  it('注销：冷静期登录 403 带 deleteAt，撤销后能登录（F-ACC-08）', async () => {
    const d = device();
    const { username } = await newUser(d);
    await d.connect();
    await expect(d.account.requestDelete('wrong-password-1')).rejects.toMatchObject({ code: 4018 });
    expect(d.account.session).not.toBeNull();
    await d.account.requestDelete(PASSWORD);
    expect(d.account.session).toBeNull();
    await until(() => d.im.state === 'disconnected', 'disconnected');
    expect(d.fatal).toHaveLength(1);
    await expect(device().account.login(username, PASSWORD)).rejects.toMatchObject({
      status: 403,
      code: 4030,
      reason: 'accountDeletionPending',
    });
    await device().account.cancelDelete(username, PASSWORD);
    await expect(device().account.login(username, PASSWORD)).resolves.toMatchObject({ userId: username });
  });
});

describe('真实服务端：日志', () => {
  it('跑完上面的流程，SDK 日志里没有 token、refresh、恢复码', async () => {
    const d = device();
    const { recoveryCode } = await newUser(d);
    await d.connect();
    const access = d.account.session!.accessToken;
    const refresh = d.account.session!.refreshToken!;
    await d.account.refresh();
    await expect(d.account.changePassword('wrong-password-1', NEW_PASSWORD)).rejects.toMatchObject({ code: 4018 });
    await d.account.changePassword(PASSWORD, NEW_PASSWORD);
    expect(d.logs.length).toBeGreaterThan(0);
    for (const l of d.logs) {
      for (const secret of [access, refresh, recoveryCode, PASSWORD, NEW_PASSWORD]) expect(l).not.toContain(secret);
    }
    expect(d.logs.join('\n')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
