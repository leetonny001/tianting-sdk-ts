// FE-680（C5）× 真实服务端（IM_CONV_SETTINGS_ENABLED=1）：置顶、免打扰、删除、多端同步。
// 服务端命令随 BE-483～486；在那之前 convSet、convDelete 返回 4001，这里的用例如实失败，不跳过、不放宽。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountClient,
  IMClient,
  WebSocketTransport,
  c2cConvId,
  type Message,
  type TransportConnection,
  type TransportHandlers,
} from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

let srv: RunningServer;
const clients: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer({ IM_CONV_SETTINGS_ENABLED: '1' });
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** 真实 WebSocket，能模拟断网：cut 之后新连接立即以 1006 失败，restore 之后按退避重连成功。 */
class GateTransport extends WebSocketTransport {
  offline = false;
  private conn: TransportConnection | null = null;

  override open(url: string, h: TransportHandlers): TransportConnection {
    if (this.offline) {
      setTimeout(() => h.onClose(1006, ''), 0);
      return { send: () => undefined, close: () => undefined };
    }
    this.conn = super.open(url, h);
    return this.conn;
  }

  cut(): void {
    this.offline = true;
    this.conn?.close(4000, 'offline'); // 4000 不是"不重连"的关闭码
  }
}

function client(transport = new GateTransport()): IMClient {
  const im = new IMClient({
    url: srv.wsURL,
    browserEvents: false,
    transport,
    timings: { backoffBaseMs: 50, backoffMaxMs: 100 },
  });
  clients.push(im);
  return im;
}

async function login(userId: string, im = client()): Promise<IMClient> {
  im.connect(await srv.token(userId));
  await until(() => im.state === 'connected' && im.userId === userId, `${userId} connected`);
  return im;
}

let n = 0;
const uid = (base: string) => `${base}${Date.now().toString(36)}${n++}`;

async function users(...ids: string[]): Promise<void> {
  await srv.admin('POST', '/admin/users/import', { users: ids.map((userId) => ({ userId })) });
}

async function sent(im: IMClient, convId: string, text: string): Promise<Message> {
  const r = im.send(convId, text);
  if (!r.ok) throw new Error('send');
  return until(
    () => im.messages(convId).find((m) => m.clientMsgId === r.message.clientMsgId && m.status === 'sent'),
    `sent ${text}`,
  );
}

const convOf = (im: IMClient, convId: string) => im.conversations().find((c) => c.convId === convId);
const order = (im: IMClient) =>
  im.conversations().map((c) => [c.convId, c.pinned === true, c.pinnedAt ?? null, c.notifyOff === true]);

describe('会话设置 × 真实服务端', () => {
  it('backend-chat 第 75 条：GET /v1/config 的 features.convSettings 读到 true', async () => {
    const cfg = await new AccountClient({ baseUrl: srv.httpURL, platform: 'web' }).getConfig();
    expect(cfg.features.convSettings).toBe(true);
  });

  it('TC-CVS-04-01（AC-CVS-04-1）：D1 置顶、免打扰：D2 2 秒内更新；ack 后 D1 的 pinnedAt 是服务端的', async () => {
    const [u1, u2] = [uid('pa'), uid('pb')];
    await users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const [d1, d2, b] = [await login(u1), await login(u1), await login(u2)];
    await sent(b, conv, 'hi');
    await until(() => convOf(d1, conv) && convOf(d2, conv), 'conv on both devices');
    const t0 = Date.now();
    await d1.setConvPinned(conv, true);
    await d1.setConvNotifyOff(conv, true);
    const pinnedAt = convOf(d1, conv)!.pinnedAt!;
    expect(convOf(d1, conv)).toMatchObject({ pinned: true, notifyOff: true });
    await until(() => convOf(d2, conv)?.pinned && convOf(d2, conv)?.notifyOff, 'D2 updated', 2_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(convOf(d2, conv)!.pinnedAt).toBe(pinnedAt);
    expect(d2.conversations()[0]!.convId).toBe(conv);
    expect(d2.totalUnread()).toBe(0); // 免打扰、没有 @
  });

  it('TC-CVS-04-05、TC-CVS-03-02（AC-CVS-04-5、03-2）：D1 删除单聊：D2 2 秒内收到 convDeleted，会话消失、内存搜不到；u2 再发 1 条，两端重新出现，未读 1，minSeq 正确', async () => {
    const [u1, u2] = [uid('da'), uid('db')];
    await users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const [d1, d2, b] = [await login(u1), await login(u1), await login(u2)];
    for (let i = 1; i <= 3; i++) await sent(b, conv, `ZXQ-CVS-1 第 ${i} 条`);
    await until(() => convOf(d2, conv)?.maxSeq === 3, 'D2 has 3');
    await d2.loadHistory(conv);
    expect(d2.messages(conv)).toHaveLength(3);
    const drafts: string[] = [];
    d2.on('convDeleted', (id) => drafts.push(id));
    const t0 = Date.now();
    await d1.deleteConv(conv);
    expect(convOf(d1, conv)).toBeUndefined();
    await until(() => drafts.includes(conv), 'D2 convDeleted', 2_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(convOf(d2, conv)).toBeUndefined();
    expect(d2.conversationSnapshot(conv)).toBeUndefined();
    for (const im of [d1, d2]) expect(JSON.stringify(im.debugExport())).not.toContain('ZXQ-CVS-1');

    await sent(b, conv, '新的一条');
    for (const im of [d1, d2]) {
      await until(() => convOf(im, conv)?.unread === 1, 'reappears with unread 1');
      expect(convOf(im, conv)).toMatchObject({ minSeq: 4, unread: 1 });
      await im.loadHistory(conv);
      expect(im.messages(conv).map((m) => m.body.text)).toEqual(['新的一条']);
    }
    // 新连接：convs 里 minSeq=4，deleted 不再含它。
    const d3 = await login(u1);
    await until(() => convOf(d3, conv), 'convs');
    expect(convOf(d3, conv)).toMatchObject({ minSeq: 4, unread: 1 });
    expect(convOf(b, conv)!.minSeq).toBe(1); // 对方不受影响
  });

  it('TC-CVS-03-05（AC-CVS-03-5）：D2 离线时 D1 删除 g1：D2 重连后 g1 消失，没有 convRemoved、没有快照，可以照常发言', async () => {
    const [u1, u2] = [uid('ga'), uid('gb')];
    await users(u1, u2);
    const groupId = uid('g');
    await srv.admin('POST', '/admin/groups', { groupId, name: groupId, members: [u1, u2] });
    const g = `group:${groupId}`;
    const gate = new GateTransport();
    const [d1, d2] = [await login(u1), await login(u1, client(gate))];
    const b = await login(u2);
    await sent(b, g, 'ZXQ-CVS-6');
    await until(() => convOf(d2, g)?.maxSeq, 'D2 has g');
    await d2.loadHistory(g);
    const removed: string[] = [];
    d2.on('convRemoved', (id) => removed.push(id));
    gate.cut();
    await until(() => d2.state !== 'connected', 'D2 offline');
    await d1.deleteConv(g);
    gate.offline = false;
    await until(() => d2.state === 'connected', 'D2 back', 10_000);
    await until(() => !convOf(d2, g), 'g1 gone');
    expect(removed).toEqual([]);
    expect(d2.conversationSnapshot(g)).toBeUndefined();
    expect(JSON.stringify(d2.debugExport())).not.toContain('ZXQ-CVS-6');
    expect((await d2.loadMyGroups()).map((x) => x.groupId)).toContain(groupId);
    await sent(d2, g, '我还在群里');
    await until(() => convOf(b, g)?.lastMsg?.text === '我还在群里', 'u2 receives');
  });

  it('TC-CVS-04-02（AC-CVS-04-2）：D2 离线时 D1 置顶 c1 并删除 c2：D2 重连后列表和 D1 一致，c2 本地消息被清除', async () => {
    const [u1, u2, u3] = [uid('oa'), uid('ob'), uid('oc')];
    await users(u1, u2, u3);
    const c1 = c2cConvId(u1, u2);
    const c2 = c2cConvId(u1, u3);
    const gate = new GateTransport();
    const [d1, d2] = [await login(u1), await login(u1, client(gate))];
    await sent(await login(u2), c1, 'c1');
    await sent(await login(u3), c2, 'ZXQ-CVS-7');
    await until(() => convOf(d2, c1) && convOf(d2, c2), 'D2 has both');
    await d2.loadHistory(c2);
    gate.cut();
    await until(() => d2.state !== 'connected', 'D2 offline');
    await d1.setConvPinned(c1, true);
    await d1.deleteConv(c2);
    gate.offline = false;
    await until(() => d2.state === 'connected', 'D2 back', 10_000);
    await until(() => convOf(d2, c1)?.pinned && !convOf(d2, c2), 'D2 synced');
    expect(order(d2)).toEqual(order(d1));
    expect(d2.messages(c2)).toEqual([]);
    expect(JSON.stringify(d2.debugExport())).not.toContain('ZXQ-CVS-7');
  });
});
