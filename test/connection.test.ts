import { describe, expect, it } from 'vitest';
import type { FatalReason } from '../src/index.js';
import { flush, setup } from './helpers.js';

describe('连接管理（FE-003）', () => {
  it('C-52：URL 只带 platform，连接后第一帧是 auth；收到 auth 的 ack 才算已连接', async () => {
    const h = setup({ platform: 'pc' });
    const states: string[] = [];
    h.im.on('state', (s) => states.push(s));
    h.im.connect('secret-token-xyz');
    const c = h.transport.current;
    expect(c.url).toBe('ws://im.test/ws?platform=pc');
    expect(c.url).not.toContain('secret');
    c.open();
    expect(c.frames()[0]).toEqual({ id: 'auth1', cmd: 'auth', data: { token: 'secret-token-xyz' } });
    expect(h.im.state).toBe('connecting');
    c.ack('auth', { userId: 'alice', serverTime: 1 });
    expect(h.im.state).toBe('connected');
    expect(h.im.userId).toBe('alice');
    expect(states).toEqual(['connecting', 'connected']);
    await flush();
    expect(c.last('convs')).toBeTruthy(); // 连上后先拉会话列表
  });

  it('心跳每 30 秒一次；10 秒收不到 pong 判定断线并重连（AC-CONN-01-6）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login();
    h.clock.advance(30_000);
    expect(c.sent.filter((s) => s === '{"cmd":"ping"}')).toHaveLength(1);
    c.receive({ cmd: 'pong' });
    h.clock.advance(30_000);
    expect(c.sent.filter((s) => s === '{"cmd":"ping"}')).toHaveLength(2);
    h.clock.advance(9_999); // 第二次 ping 没有 pong
    expect(h.im.state).toBe('connected');
    h.clock.advance(1);
    expect(h.im.state).toBe('disconnected');
    expect(c.closedWith).not.toBeNull();
    h.clock.advance(1_000); // 第一次重连等 1 秒
    expect(h.transport.connections).toHaveLength(2);
  });

  it('退避：1、2、4、8、16、30、30 秒（AC-CONN-01-5）；连接成功后重置为 1 秒（C-22）', async () => {
    const h = setup();
    h.im.connect('t');
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      h.transport.current.drop(1006);
      const before = h.transport.connections.length;
      let waited = 0;
      while (h.transport.connections.length === before) {
        h.clock.advance(100);
        waited += 100;
      }
      gaps.push(waited);
    }
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    await h.login();
    h.transport.current.drop(1006);
    h.clock.advance(999);
    expect(h.transport.connections).toHaveLength(8);
    h.clock.advance(1);
    expect(h.transport.connections).toHaveLength(9);
  });

  it('抖动在 ±20% 以内', () => {
    for (const [r, want] of [
      [0, 800],
      [0.999999, 1200],
    ] as const) {
      const h = setup({ random: () => r });
      h.im.connect('t');
      h.transport.current.drop(1006);
      h.clock.advance(want - 1);
      expect(h.transport.connections).toHaveLength(1);
      h.clock.advance(1);
      expect(h.transport.connections).toHaveLength(2);
    }
  });

  it('网络恢复（online）时立即重连，不等退避（PRD F-CONN-01 规则 3）', () => {
    const h = setup();
    h.im.connect('t');
    h.transport.current.drop(1006);
    h.clock.advance(1_000);
    h.transport.current.drop(1006); // 第二次失败，下一次要等 2 秒
    expect(h.transport.connections).toHaveLength(2);
    h.im.networkOnline();
    expect(h.transport.connections).toHaveLength(3);
  });

  for (const [reason, code] of [
    ['tokenInvalid', 4010],
    ['tokenExpired', 4011],
    ['banned', 4012],
    ['tooManyConnections', 4429],
  ] as const) {
    it(`被踢 ${reason}/${code} 不重连，通知界面（AC-AUTH-02-4、AC-AUTH-02-10、AC-AUTH-03-5）`, async () => {
      const h = setup();
      const fatal: FatalReason[] = [];
      h.im.on('fatal', (r) => fatal.push(r));
      h.im.connect('t');
      const c = await h.login();
      c.receive({ cmd: 'event', data: { type: 'kicked', reason } });
      c.drop(code, reason);
      expect(fatal).toEqual([{ kind: 'kicked', reason, code }]);
      h.clock.advance(120_000);
      expect(h.transport.connections).toHaveLength(1);
    });
  }

  it('关闭码 1000、4009 不重连（没有 kicked 也一样）', () => {
    for (const code of [1000, 4009]) {
      const h = setup();
      const fatal: FatalReason[] = [];
      h.im.on('fatal', (r) => fatal.push(r));
      h.im.connect('t');
      h.transport.current.drop(code, 'x');
      expect(fatal).toEqual([{ kind: 'closed', code, reason: 'x' }]);
      h.clock.advance(60_000);
      expect(h.transport.connections).toHaveLength(1);
    }
  });

  it('serverShutdown（1001）、4401、4408、1006 按退避重连（C-55、C-52）', async () => {
    for (const [code, kicked] of [
      [1001, 'serverShutdown'],
      [4401, null],
      [4408, null],
      [1006, null],
    ] as const) {
      const h = setup();
      const fatal: FatalReason[] = [];
      h.im.on('fatal', (r) => fatal.push(r));
      h.im.connect('t');
      const c = await h.login();
      if (kicked) c.receive({ cmd: 'event', data: { type: 'kicked', reason: kicked } });
      c.drop(code);
      h.clock.advance(1_000);
      expect(fatal, `code ${code}`).toEqual([]);
      expect(h.transport.connections, `code ${code}`).toHaveLength(2);
    }
  });

  it('退出登录以 1000 关闭，不再重连，清空数据（AC-AUTH-05-1）', async () => {
    const h = setup();
    h.im.connect('t');
    const c = await h.login('alice', [
      {
        convId: 'c2c:alice:bob',
        type: 'c2c',
        name: 'bob',
        maxSeq: 1,
        readSeq: 0,
        minSeq: 1,
        unread: 1,
        lastMsg: null,
        updatedAt: 1,
      },
    ]);
    expect(h.im.conversations()).toHaveLength(1);
    h.im.disconnect();
    expect(c.closedWith).toEqual({ code: 1000, reason: 'logout' });
    expect(h.im.state).toBe('disconnected');
    expect(h.im.conversations()).toEqual([]);
    h.clock.advance(60_000);
    expect(h.transport.connections).toHaveLength(1);
  });

  it('日志里不出现 token（FE-003 第 7 条）', async () => {
    const h = setup();
    h.im.connect('super-secret-token');
    const c = await h.login();
    c.receive('not json');
    c.drop(1006);
    h.clock.advance(1_000);
    h.transport.current.open();
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join('\n')).not.toContain('super-secret-token');
  });

  it('断开 0.5 秒就恢复时不显示连接提示；超过 1 秒才显示，恢复后立即消失（AC-CONN-02-3、F-CONN-02）', async () => {
    const h = setup();
    const banner: boolean[] = [];
    h.im.on('banner', (b) => banner.push(b));
    h.im.connect('t');
    await h.login();
    banner.length = 0;
    h.transport.current.drop(1006);
    h.clock.advance(500);
    // 重连成功（第一次退避 1 秒内由 online 触发）
    h.im.networkOnline();
    await h.login();
    h.clock.advance(5_000);
    expect(banner).toEqual([]);

    h.transport.current.drop(1006);
    h.clock.advance(999);
    expect(banner).toEqual([]);
    h.clock.advance(1);
    expect(banner).toEqual([true]);
    h.clock.advance(1_000); // 退避到期，重连
    await h.login();
    expect(banner).toEqual([true, false]);
  });
});
