// securityNotice 到达 SDK：真实 im-server，单独一个进程（要冻结服务端时钟、信任 X-Forwarded-For，别的文件用真实时钟）。
// F-ACC-02 规则 3b、F-ACC-03 规则 4、F-ACC-05 规则 5；问题表 A13、A14。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountClient, IMClient, type AccountSession, type SessionStore } from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

const PASSWORD = 'Tt-good-pass-2026!';
const NEW_PASSWORD = 'Tt-new-pass-2026!';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let srv: RunningServer;
const ims: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer({ IM_REGISTER_MODE: 'invite', IM_TRUSTED_PROXIES: '127.0.0.1' });
});
afterEach(async () => {
  await srv.admin('POST', '/admin/test/clock', {}); // 恢复真实时钟
});
afterAll(async () => {
  for (const im of ims) im.destroy();
  await srv?.stop();
});

async function until<T>(fn: () => T | undefined | false, what: string, timeout = 5_000): Promise<T> {
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

/** 收到的 securityNotice 和踢线按到达顺序记在 log：kind 或 kicked/原因。 */
function device(platform: 'web' | 'ios') {
  const account = new AccountClient({ baseUrl: srv.httpURL, platform, store: new Store() });
  const im = new IMClient({ url: srv.wsURL, platform, browserEvents: false });
  ims.push(im);
  const log: string[] = [];
  const platforms: Record<string, string | undefined> = {};
  im.on('securityNotice', (n) => {
    log.push(n.kind);
    platforms[n.kind] = n.platform;
  });
  im.on('fatal', (f) => log.push(f.kind === 'kicked' ? `kicked/${f.reason}` : f.kind));
  return {
    account,
    im,
    log,
    platforms,
    async connect() {
      im.connect(account.tokenProvider);
      await until(() => im.state === 'connected', 'connected');
    },
  };
}

let serial = 0;
/** 新账号：d1 注册并确认恢复码，d2 登录，都不连接。 */
async function pair() {
  serial += 1;
  const username = `notice_${Date.now().toString(36)}${serial}`;
  const r = await srv.signed('POST', '/admin/invites', { count: 1, maxUses: 1, expiresAt: Date.now() + 86_400_000 });
  const code = (r['invites'] as Array<{ code: string }>)[0]!.code;
  const d1 = device('web');
  const reg = await d1.account.register({ username, password: PASSWORD, inviteCode: code });
  await d1.account.ackRecoveryCode(reg.recoveryCodeGen!);
  const d2 = device('ios');
  await d2.account.login(username, PASSWORD);
  return { username, recoveryCode: reg.recoveryCode!, d1, d2 };
}

/** 不经过 SDK 的刷新：持有偷来 refresh 的人。 */
async function rawRefresh(token: string, ip?: string): Promise<{ status: number; accessToken?: string }> {
  const res = await fetch(`${srv.httpURL}/v1/account/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: JSON.stringify({ refreshToken: token }),
  });
  const body = (await res.json()) as { accessToken?: string };
  return { status: res.status, accessToken: body.accessToken };
}

const setClock = (nowMs: number) => srv.admin('POST', '/admin/test/clock', { nowMs });
const quiet = () => new Promise((r) => setTimeout(r, 200));

describe('真实服务端：securityNotice 到达 SDK', () => {
  it('refreshReplay：其他设备收到，这条会话的连接不提醒（AC-ACC-03-25）', async () => {
    const { d1, d2 } = await pair();
    await d2.connect();
    const stolen = d1.account.session!.refreshToken!;
    const now = Date.now();
    await setClock(now);
    const x = await rawRefresh(stolen);
    expect(x.status).toBe(200);
    // 攻击者转正，窗口过后 d1 手里的旧值就是重放。
    const events = await fetch(`${srv.httpURL}/v1/account/events`, {
      headers: { Authorization: `Bearer ${x.accessToken}` },
    });
    expect(events.status).toBe(200);
    await setClock(now + 3 * MINUTE);
    expect((await rawRefresh(stolen)).status).toBe(401);
    await until(() => d2.log.includes('refreshReplay'), 'refreshReplay');
    expect(d2.platforms['refreshReplay']).toBe('web');
  });

  it('refreshRateLimited：连续 6 小时限流，第 6 小时其他设备才收到（AC-ACC-03-45）', async () => {
    const { d1, d2 } = await pair();
    await d2.connect();
    const held = d1.account.session!.refreshToken!;
    const start = Date.now();
    for (let hour = 0; hour < 6; hour++) {
      await setClock(start + hour * HOUR);
      for (let i = 0; i < 21; i++) {
        expect((await rawRefresh(held)).status).toBe(i === 20 ? 429 : 200);
      }
      if (hour === 4) {
        await quiet();
        expect(d2.log).toEqual([]);
      }
    }
    await until(() => d2.log.includes('refreshRateLimited'), 'refreshRateLimited');
    expect(d2.platforms['refreshRateLimited']).toBe('web');
  });

  it('newIpPrefix：刷新来自没见过的前缀，其他设备收到，发起的设备不提醒；同一前缀不再提醒（A13）', async () => {
    const { d1, d2 } = await pair();
    await d1.connect();
    await d2.connect();
    const first = await rawRefresh(d1.account.session!.refreshToken!, '192.0.2.1');
    expect(first.status).toBe(200);
    await until(() => d2.log.includes('newIpPrefix'), 'newIpPrefix');
    expect(d2.platforms['newIpPrefix']).toBe('web');
    await quiet();
    expect(d1.log).toEqual([]);
    await rawRefresh(d1.account.session!.refreshToken!, '192.0.2.77');
    await quiet();
    expect(d2.log).toEqual(['newIpPrefix']);
  });

  it('recoveryCodeRegenerated：发起的设备不提醒（A14）', async () => {
    const { d1, d2 } = await pair();
    await d1.connect();
    await d2.connect();
    await d1.account.regenerateRecoveryCode(PASSWORD);
    await until(() => d2.log.includes('recoveryCodeRegenerated'), 'recoveryCodeRegenerated');
    await quiet();
    expect(d1.log).toEqual([]);
  });

  it('passwordChanged：其他设备先提醒再踢线，发起的设备都没有（F-ACC-05 规则 5）', async () => {
    const { d1, d2 } = await pair();
    await d1.connect();
    await d2.connect();
    await d1.account.changePassword(PASSWORD, NEW_PASSWORD);
    await until(() => d2.log.length >= 2, 'd2 kicked');
    expect(d2.log).toEqual(['passwordChanged', 'kicked/passwordChanged']);
    expect(d2.platforms['passwordChanged']).toBe('web');
    await quiet();
    expect(d1.log).toEqual([]);
  });

  it('passwordRecovered：所有在线设备先提醒再踢线（F-ACC-02 规则 3b）', async () => {
    const { username, recoveryCode, d1, d2 } = await pair();
    await d1.connect();
    await d2.connect();
    await device('web').account.recover(username, recoveryCode, NEW_PASSWORD);
    await until(() => d1.log.length >= 2 && d2.log.length >= 2, 'both kicked');
    expect(d1.log).toEqual(['passwordRecovered', 'kicked/passwordChanged']);
    expect(d2.log).toEqual(['passwordRecovered', 'kicked/passwordChanged']);
  });
});
