// 系统推送 × 真实 im-server（PRD-live 第 4 节）：离线补收、闪断重连、幂等重放、4001 静默。
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMClient, c2cConvId, type IMClientOptions, type Platform, type Push } from '../../src/index.js';
import { WebSocketTransport, type TransportConnection, type TransportHandlers } from '../../src/transport.js';
import { PUSH_ENV, startServer, type RunningServer } from './server.js';

let srv: RunningServer;
const clients: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer(PUSH_ENV);
});
afterAll(async () => {
  for (const c of clients) c.destroy();
  await srv?.stop();
});

async function until<T>(fn: () => T | undefined | false | null, what: string, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 真实 WebSocket，多两件事：记下发出的帧，能模拟闪断。 */
class SpyTransport extends WebSocketTransport {
  sent: Array<{ cmd: string; data?: Record<string, unknown> }> = [];
  raw: string[] = [];
  private conn: TransportConnection | null = null;

  override open(url: string, h: TransportHandlers): TransportConnection {
    const inner = super.open(url, h);
    this.conn = inner;
    return {
      send: (text) => {
        this.raw.push(text);
        this.sent.push(JSON.parse(text));
        inner.send(text);
      },
      close: (code, reason) => inner.close(code, reason),
    };
  }

  /** 闪断：服务端看到连接断开，客户端按退避重连（4000 不是"不重连"的关闭码）。 */
  flash(): void {
    this.conn?.close(4000, 'flash');
  }

  syncs() {
    return this.sent.filter((f) => f.cmd === 'pushSync').map((f) => f.data);
  }
}

let n = 0;
const uid = (base: string) => `${base}${Date.now().toString(36)}${n++}`;

interface Rig {
  im: IMClient;
  transport: SpyTransport;
  got: Push[];
  synced: number[];
  logs: string[];
}

function rig(opts: Partial<IMClientOptions> = {}, platform: Platform = 'web', server = () => srv): Rig {
  const transport = new SpyTransport();
  const logs: string[] = [];
  const im = new IMClient({
    url: server().wsURL,
    platform,
    transport,
    browserEvents: false,
    timings: { backoffBaseMs: 20, backoffMaxMs: 50 },
    logger: {
      debug: (m) => logs.push(m),
      warn: (m) => logs.push(m),
      error: (m, e) => logs.push(`${m} ${String(e)}`),
    },
    ...opts,
  });
  clients.push(im);
  const got: Push[] = [];
  const synced: number[] = [];
  im.on('push', (p) => got.push(p));
  im.on('pushSynced', (e) => synced.push(e.latestSeq));
  return { im, transport, got, synced, logs };
}

async function online(r: Rig, userId: string, server = () => srv): Promise<void> {
  r.im.connect(await server().token(userId));
  await until(() => r.im.state === 'connected' && r.im.userId === userId, `${userId} connected`);
}

/** 登录并等第一轮补拉结束。 */
async function ready(r: Rig, userId: string): Promise<void> {
  const before = r.synced.length;
  await online(r, userId);
  await until(() => r.synced.length > before, `${userId} first pushSynced`);
}

async function ensureUsers(...ids: string[]) {
  await srv.admin('POST', '/admin/users/import', { users: ids.map((userId) => ({ userId })) });
}

function pushTo(userId: string, extra: Record<string, unknown> = {}) {
  const pushId = randomUUID();
  return srv
    .signed('POST', '/admin/push', {
      target: 'user',
      userIds: [userId],
      type: 'notice',
      data: { text: `t-${pushId}` },
      pushId,
      ...extra,
    })
    .then((res) => ({ pushId, ...res, ...('pushId' in extra ? { pushId: extra.pushId as string } : {}) }));
}

describe('实时下发（AC-PUSH-01-1）', () => {
  it('在线用户 3 秒内收到，字段正确；游标和 pushSynced 正确', async () => {
    const u = uid('live');
    await ensureUsers(u);
    const r = rig();
    await ready(r, u);
    expect(r.synced).toEqual([0]);
    const start = Date.now();
    const { pushId } = await pushTo(u);
    const p = await until(() => r.got[0], 'live push', 3_000);
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(p).toMatchObject({
      pushId,
      type: 'notice',
      data: { text: `t-${pushId}` },
      target: 'user',
      pushSeq: 1,
      replayed: false,
    });
    expect(typeof p.ts).toBe('number');
    expect(r.im.pushCursor()).toBe(1);
  });
});

describe('离线补收', () => {
  it('离线期间的推送上线后按序收到，replayed=true，游标和 pushSynced 到最新；重复一遍没有重复交付', async () => {
    const u = uid('off');
    await ensureUsers(u);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await pushTo(u)).pushId);
    await sleep(5); // T0 严格晚于这些推送的 ts
    const r = rig();
    await ready(r, u);
    expect(r.got.map((p) => p.pushId)).toEqual(ids);
    expect(r.got.map((p) => p.pushSeq)).toEqual([1, 2, 3]);
    expect(r.got.every((p) => p.replayed)).toBe(true);
    expect(r.synced).toEqual([3]);
    expect(r.im.pushCursor()).toBe(3);
    expect(r.transport.syncs()).toEqual([{ afterSeq: 0, limit: 100 }]);
  });

  it('AC-PUSH-03-15：120 条翻两页，按序只交付一次；AC-PUSH-07-4 不含别人的', async () => {
    const u = uid('page');
    const other = uid('other');
    await ensureUsers(u, other);
    const ids: string[] = [];
    await pushTo(other);
    for (let i = 0; i < 120; i++) ids.push((await pushTo(u)).pushId);
    const r = rig();
    await ready(r, u);
    expect(r.got.map((p) => p.pushId)).toEqual(ids);
    expect(r.transport.syncs()).toEqual([
      { afterSeq: 0, limit: 100 },
      { afterSeq: 100, limit: 100 },
    ]);
    expect(r.synced).toEqual([120]);
  });

  it('AC-PUSH-03-5、AC-ADM-50-3：ttlSeconds=0 和全员只投在线，离线的补不到；在线的不带 pushSeq，不动游标', async () => {
    const on = uid('on');
    const off = uid('off');
    await ensureUsers(on, off);
    const r = rig();
    await ready(r, on);
    const zero = await pushTo(on, { ttlSeconds: 0 });
    await pushTo(off, { ttlSeconds: 0 });
    const allId = randomUUID();
    await srv.signed('POST', '/admin/push', { target: 'all', type: 'notice', data: { text: 'all' }, pushId: allId });
    await until(() => r.got.length === 2, 'both online frames');
    expect(r.got.map((p) => p.pushId).sort()).toEqual([zero.pushId, allId].sort());
    expect(r.got.every((p) => p.pushSeq === undefined && !p.replayed)).toBe(true);
    expect(r.got.find((p) => p.pushId === allId)?.target).toBe('all');
    expect(r.im.pushCursor()).toBe(0);

    const late = rig();
    await ready(late, off);
    await sleep(100);
    expect(late.got).toEqual([]);
    expect(late.synced).toEqual([0]);
  });

  it('AC-PUSH-07-1、07-2：两个在线连接各收一次；离线设备之后自己补收', async () => {
    const u = uid('multi');
    await ensureUsers(u);
    const web = rig();
    const pc = rig({}, 'pc');
    await ready(web, u);
    await ready(pc, u);
    const { pushId } = await pushTo(u);
    await until(() => web.got.length === 1 && pc.got.length === 1, 'both devices');
    expect(web.got[0]!.pushId).toBe(pushId);
    expect(pc.got[0]!.pushId).toBe(pushId);
    const android = rig({}, 'android');
    await ready(android, u);
    expect(android.got.map((p) => p.pushId)).toEqual([pushId]);
    await sleep(100);
    expect(web.got).toHaveLength(1);
  });

  it('AC-PUSH-07-3、07-5、07-6：同实例换号，同一 pushId 各交付一次；回到 u1 从 0 回放', async () => {
    const u1 = uid('swap');
    const u2 = uid('swap');
    await ensureUsers(u1, u2);
    const pushId = randomUUID();
    await srv.signed('POST', '/admin/push', {
      target: 'user',
      userIds: [u1, u2],
      type: 'notice',
      data: { text: 'shared' },
      pushId,
    });
    const r = rig();
    await ready(r, u1);
    expect(r.got.map((p) => p.pushId)).toEqual([pushId]);
    r.im.disconnect();
    expect(r.im.pushCursor()).toBeNull();
    await ready(r, u2);
    expect(r.got.map((p) => p.pushId)).toEqual([pushId, pushId]);
    r.im.disconnect();
    await ready(r, u1);
    expect(r.got.map((p) => p.pushId)).toEqual([pushId, pushId, pushId]);
    expect(r.got[2]!.replayed).toBe(true);
    expect(r.transport.syncs().at(-1)).toEqual({ afterSeq: 0, limit: 100 });
  });

  it('AC-PUSH-03-17：pushStart=latest 不回放历史，只收之后的', async () => {
    const u = uid('latest');
    await ensureUsers(u);
    await pushTo(u);
    await pushTo(u);
    const r = rig({ pushStart: 'latest' });
    await ready(r, u);
    expect(r.got).toEqual([]);
    expect(r.im.pushCursor()).toBe(2);
    expect(r.transport.syncs()).toEqual([{ fromLatest: true }]);
    const { pushId } = await pushTo(u);
    await until(() => r.got[0], 'next push');
    expect(r.got[0]).toMatchObject({ pushId, pushSeq: 3, replayed: false });
  });
});

describe('闪断重连', () => {
  it('闪断期间的推送重连后补到，replayed=false（T0 不变），不重复；之后的实时帧接上', async () => {
    const u = uid('flash');
    await ensureUsers(u);
    const r = rig();
    await ready(r, u);
    const first = await pushTo(u);
    await until(() => r.got.length === 1, 'first push');

    const down = until(() => r.im.state !== 'connected', 'disconnected');
    r.transport.flash();
    await down;
    // 断开期间推两条：连接已经不在服务端的注册表里，只能靠补拉。
    const a = await pushTo(u);
    const b = await pushTo(u);
    await until(() => r.got.length === 3, 'caught up after flash');
    expect(r.got.map((p) => p.pushId)).toEqual([first.pushId, a.pushId, b.pushId]);
    expect(r.got.every((p) => !p.replayed)).toBe(true);
    expect(r.im.pushCursor()).toBe(3);
    expect(r.transport.syncs().at(-1)).toEqual({ afterSeq: 1, limit: 100 });

    const c = await pushTo(u);
    await until(() => r.got.length === 4, 'live after reconnect');
    expect(r.got[3]!.pushId).toBe(c.pushId);
    await sleep(100);
    expect(r.got).toHaveLength(4);
  });

  it('AC-PUSH-11-2：服务端跳过一条实时帧，SDK 发现缺口后 500ms 补拉，按序交付', async () => {
    const u = uid('gap');
    await ensureUsers(u);
    const r = rig();
    await ready(r, u);
    const lost = randomUUID();
    await srv.admin('POST', '/admin/test/faults/push-skip-delivery', { pushId: lost });
    await pushTo(u, { pushId: lost });
    await sleep(100);
    expect(r.got).toEqual([]);
    const next = await pushTo(u);
    await until(() => r.got.length === 2, 'gap filled', 3_000);
    expect(r.got.map((p) => p.pushId)).toEqual([lost, next.pushId]);
    expect(r.got.every((p) => !p.replayed)).toBe(true);
    expect(r.im.pushCursor()).toBe(2);
    expect(r.transport.syncs().at(-1)).toEqual({ afterSeq: 0, limit: 100 });
  });
});

describe('幂等重放（AC-PUSH-06-1、06-2、06-5）', () => {
  it('同一 pushId 同内容重放：created=false，只交付一次，收件箱一条；不同内容 409', async () => {
    const u = uid('idem');
    await ensureUsers(u);
    const r = rig();
    await ready(r, u);
    const body = { target: 'user', userIds: [u], type: 'notice', data: { text: 'once' }, pushId: randomUUID() };
    expect(await srv.signed('POST', '/admin/push', body)).toMatchObject({ created: true, accepted: 1 });
    await until(() => r.got.length === 1, 'first delivery');
    expect(await srv.signed('POST', '/admin/push', body)).toMatchObject({ created: false });
    await expect(srv.signed('POST', '/admin/push', { ...body, data: { text: 'other' } })).rejects.toThrow(/409/);
    await sleep(200);
    expect(r.got).toHaveLength(1);
    const inbox = (await srv.admin('GET', `/admin/test/push-inbox/${u}`)) as { rows: unknown[] };
    expect(inbox.rows).toHaveLength(1);

    // 重连后 afterSeq=1，不再拿回这一条；新实例从 0 回放时也只有一条。
    const fresh = rig();
    await ready(fresh, u);
    expect(fresh.got.map((p) => p.pushId)).toEqual([body.pushId]);
  });

  it('全员推送 done 之后重放不再广播', async () => {
    const u = uid('idemall');
    await ensureUsers(u);
    const r = rig();
    await ready(r, u);
    const body = { target: 'all', type: 'notice', data: { text: 'all-once' }, pushId: randomUUID() };
    expect(await srv.signed('POST', '/admin/push', body)).toMatchObject({ created: true });
    await until(() => r.got.some((p) => p.pushId === body.pushId), 'broadcast');
    expect(await srv.signed('POST', '/admin/push', body)).toMatchObject({ created: false });
    await sleep(200);
    expect(r.got.filter((p) => p.pushId === body.pushId)).toHaveLength(1);
  });
});

describe('日志（AC-PUSH-08-3、C-52）', () => {
  it('真实收发和重连之后，日志里没有 data，token 只在 auth 帧里、不在 URL', async () => {
    const u = uid('logs');
    await ensureUsers(u);
    const r = rig();
    const token = await srv.token(u);
    r.im.connect(token);
    await until(() => r.synced.length === 1, 'first round');
    const secret = `SECRET-${randomUUID()}`;
    await srv.signed('POST', '/admin/push', {
      target: 'user',
      userIds: [u],
      type: 'notice',
      data: { text: secret },
      pushId: randomUUID(),
    });
    await until(() => r.got.length === 1, 'delivery');
    r.transport.flash();
    await until(() => r.synced.length === 2, 'second round');
    const logs = r.logs.join('\n');
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain(token);
    expect(r.transport.raw.filter((f) => f.includes(token)).every((f) => JSON.parse(f).cmd === 'auth')).toBe(true);
    expect(r.got[0]!.data).toEqual({ text: secret });
  });
});

describe('开关关闭（AC-PUSH-01-4、AC-PUSH-02-14）', () => {
  let off: RunningServer;
  beforeAll(async () => {
    off = await startServer({});
  });
  afterAll(async () => {
    await off?.stop();
  });

  it('pushSync 得到 4001：不抛错、不重试、其他功能正常；重连后再发一次；管理接口 404', async () => {
    await expect(
      off.signed('POST', '/admin/push', {
        target: 'user',
        userIds: ['x'],
        type: 'notice',
        data: {},
        pushId: randomUUID(),
      }),
    ).rejects.toThrow(/404/);

    const a = uid('quiet');
    const b = uid('quiet');
    await off.admin('POST', '/admin/users/import', { users: [{ userId: a }, { userId: b }] });
    const r = rig({}, 'web', () => off);
    await online(r, a, () => off);
    await until(() => r.transport.syncs().length === 1, 'one pushSync');
    await sleep(2_500); // 退避第一次 1 秒、第二次 2 秒：如果重试，这里已经发生了
    expect(r.transport.syncs()).toEqual([{ afterSeq: 0, limit: 100 }]);
    expect(r.got).toEqual([]);
    expect(r.synced).toEqual([]);
    expect(r.im.pushCursor()).toBe(0);

    // 退订再订阅也不发。
    const unsub = r.im.on('push', () => {});
    unsub();
    r.im.on('push', () => {});
    await sleep(100);
    expect(r.transport.syncs()).toHaveLength(1);

    // 其他功能正常：消息照常发出。
    const conv = c2cConvId(a, b);
    r.im.send(conv, '开关关闭时消息照常');
    await until(() => r.im.messages(conv)[0]?.status === 'sent', 'message sent');

    // 下次连接再试一次。
    r.transport.flash();
    await until(() => r.transport.syncs().length === 2, 'second pushSync after reconnect');
    expect(r.im.state).toBe('connected');
    expect(r.logs.join('\n')).not.toMatch(/升级/);
  });
});
