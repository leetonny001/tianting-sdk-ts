// FE-660（C4）× 真实服务端（IM_MSG_ACTIONS_ENABLED=1）：撤回、引用、提及。
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountClient,
  IMClient,
  IMError,
  WebSocketTransport,
  c2cConvId,
  messageFor,
  quoteLabel,
  type Message,
  type TransportConnection,
  type TransportHandlers,
} from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

let srv: RunningServer;
const clients: IMClient[] = [];

beforeAll(async () => {
  srv = await startServer({
    IM_MSG_ACTIONS_ENABLED: '1',
    IM_QUARANTINE_KEY: randomBytes(32).toString('base64'), // 测试现场生成（TC-RCL 通用约定 E1）
    IM_MENTION_ALL_HOURLY: '1', // 第二次 @ 所有人就 4293
  });
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

/** 真实 WebSocket，能模拟断网：cut 之后新连接立即以 1006 失败，restore 之后按退避重连成功。记下发出的帧。 */
class GateTransport extends WebSocketTransport {
  offline = false;
  sent: Array<{ cmd: string; data?: Record<string, unknown> }> = [];
  private conn: TransportConnection | null = null;

  override open(url: string, h: TransportHandlers): TransportConnection {
    if (this.offline) {
      setTimeout(() => h.onClose(1006, ''), 0);
      return { send: () => undefined, close: () => undefined };
    }
    const inner = super.open(url, h);
    this.conn = inner;
    return {
      send: (text) => {
        this.sent.push(JSON.parse(text));
        inner.send(text);
      },
      close: (code, reason) => inner.close(code, reason),
    };
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

async function sent(
  im: IMClient,
  convId: string,
  text: string,
  opts?: Parameters<IMClient['send']>[2],
): Promise<Message> {
  const r = im.send(convId, text, opts);
  if (!r.ok) throw new Error('send');
  return until(
    () => im.messages(convId).find((m) => m.clientMsgId === r.message.clientMsgId && m.status === 'sent'),
    `sent ${text}`,
  );
}

const byId = (im: IMClient, convId: string, msgId: string) => im.messages(convId).find((m) => m.msgId === msgId);

describe('撤回 × 真实服务端', () => {
  it('问题 36（F-UI-09 规则 4）：GET /v1/config 的 features.msgActions 按 AccountConfig 的类型读到 true', async () => {
    const cfg = await new AccountClient({ baseUrl: srv.httpURL, platform: 'web' }).getConfig();
    expect(cfg.features.msgActions).toBe(true);
  });

  it('TC-RCL-01-01（AC-RCL-01-1）：u1 撤回：ack 成功；u2 和 u1 的另一端 2 秒内收到带 recalled 的 msgDeleted，文案各自正确，内存搜不到原文', async () => {
    const [u1, u2] = [uid('ra'), uid('rb')];
    await users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const [a, a2, b] = [await login(u1), await login(u1), await login(u2)];
    const m1 = await sent(a, conv, 'ZXQ-RCL-2 原文');
    await until(() => byId(b, conv, m1.msgId!), 'u2 receives');
    await until(() => byId(a2, conv, m1.msgId!), "u1' receives");
    expect(a.canRecall(m1)).toBe(true);

    const t0 = Date.now();
    await a.recall(conv, m1.msgId!);
    expect(byId(a, conv, m1.msgId!)).toMatchObject({ deleted: true, recalled: true, recalledBy: u1, body: {} });
    for (const im of [b, a2]) {
      await until(() => byId(im, conv, m1.msgId!)?.recalled, 'recalled event', 2_000);
      expect(byId(im, conv, m1.msgId!)).toMatchObject({ deleted: true, recalled: true, recalledBy: u1 });
    }
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(a.recallText(conv, byId(a, conv, m1.msgId!)!)).toBe('你撤回了一条消息');
    expect(a2.recallText(conv, byId(a2, conv, m1.msgId!)!)).toBe('你撤回了一条消息');
    expect(b.recallText(conv, byId(b, conv, m1.msgId!)!)).toBe('对方撤回了一条消息');
    expect(b.messageActions(byId(b, conv, m1.msgId!)!)).toEqual([]);
    for (const im of [a, a2, b]) expect(JSON.stringify(im.debugExport())).not.toContain('ZXQ-RCL-2');

    // 重复撤回幂等成功（AC-RCL-01-4 的客户端一侧）。
    await a.recall(conv, m1.msgId!);
    // 服务端的会话摘要也是撤回（AC-RCL-03-5），新连接按 lastMsg 显示撤回文案。
    const b2 = await login(u2);
    const last = await until(() => b2.conversations().find((c) => c.convId === conv)?.lastMsg, 'convs');
    expect(last).toMatchObject({ deleted: true, recalled: true, recalledBy: u1 });
    expect(b2.recallText(conv, last)).toBe('对方撤回了一条消息');
  });

  it('TC-RCL-01-08（AC-RCL-01-8）：服务端时间过了 121 秒，recall 返回 4097（windowSeconds=120），消息不变', async () => {
    const [u1, u2] = [uid('wa'), uid('wb')];
    await users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const a = await login(u1);
    const m1 = await sent(a, conv, '过期');
    await srv.admin('POST', '/admin/test/clock', { nowMs: m1.ts + 121_000 });
    try {
      const err = (await a.recall(conv, m1.msgId!).catch((e: unknown) => e)) as IMError;
      expect(err).toBeInstanceOf(IMError);
      expect(err).toMatchObject({ code: 4097, details: { windowSeconds: 120 } });
      expect(messageFor('recall', err.code, { windowSeconds: err.details!['windowSeconds'] as number })).toBe(
        '发送时间超过 2 分钟，无法撤回',
      );
      expect(byId(a, conv, m1.msgId!)).toMatchObject({ body: { text: '过期' } });
      expect(byId(a, conv, m1.msgId!)!.deleted).toBeUndefined();
    } finally {
      await srv.admin('POST', '/admin/test/clock', {}); // 恢复真实时钟
    }
  });

  it('TC-RCL-03-03、TC-RCL-03-11（AC-RCL-03-3、03-11）：u2 已加载两个会话后断网，u1 撤回其中一个的消息；u2 恢复后只对这个会话重拉，消息变撤回文案', async () => {
    const [u1, u2, u3] = [uid('oa'), uid('ob'), uid('oc')];
    await users(u1, u2, u3);
    const conv = c2cConvId(u1, u2);
    const quiet = c2cConvId(u3, u2);
    const a = await login(u1);
    const c = await login(u3);
    const m1 = await sent(a, conv, 'ZXQ-RCL-2 离线撤回');
    const m3 = await sent(c, quiet, '不变的会话');
    // u2 上线后打开两个会话：登录时 convs 的 modVer 是基线（只有实时消息、没有基线的会话第一次重连会保守地重拉一次）。
    const gate = new GateTransport();
    const b = await login(u2, client(gate));
    await until(() => b.conversations().length === 2, 'u2 convs');
    await b.loadHistory(conv);
    await b.loadHistory(quiet);
    await until(() => byId(b, conv, m1.msgId!) && byId(b, quiet, m3.msgId!), 'u2 loaded both');
    gate.cut();
    await until(() => b.state !== 'connected', 'u2 offline');
    await a.recall(conv, m1.msgId!);
    gate.sent = [];
    gate.offline = false;
    await until(() => b.state === 'connected', 'u2 back online');
    await until(() => byId(b, conv, m1.msgId!)?.recalled, 'recalled after reconnect');
    const resynced = gate.sent.filter((f) => f.cmd === 'sync').map((f) => f.data!['convId']);
    expect(resynced).toContain(conv);
    expect(resynced).not.toContain(quiet);
    expect(b.recallText(conv, byId(b, conv, m1.msgId!)!)).toBe('对方撤回了一条消息');
    expect(JSON.stringify(b.debugExport())).not.toContain('ZXQ-RCL-2');
  });
});

describe('引用 × 真实服务端', () => {
  it('TC-QUO-01-01（AC-QUO-01-1）：u1 引用 u2 的消息回复，u2 收到 quote state=normal 带原文摘要；之后 u2 撤回被引用的，u1 的引用变"引用内容已被撤回"', async () => {
    const [u1, u2] = [uid('qa'), uid('qb')];
    await users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const a = await login(u1);
    const b = await login(u2);
    const m1 = await sent(b, conv, 'ZXQ-QUO-1 被引用的原文');
    await until(() => byId(a, conv, m1.msgId!), 'u1 receives m1');
    const m2 = await sent(a, conv, '回复', { quote: { msgId: m1.msgId! } });
    const got = await until(() => byId(b, conv, m2.msgId!), 'u2 receives m2');
    expect(got.body.quote).toEqual({
      msgId: m1.msgId,
      seq: m1.seq,
      from: u2,
      type: 'text',
      state: 'normal',
      text: 'ZXQ-QUO-1 被引用的原文',
    });

    await b.recall(conv, m1.msgId!);
    await until(() => byId(a, conv, m2.msgId!)?.body.quote?.state === 'recalled', 'quote recalled on u1');
    expect(quoteLabel(byId(a, conv, m2.msgId!)!.body.quote!)).toBe('引用内容已被撤回');
    expect(quoteLabel(byId(b, conv, m2.msgId!)!.body.quote!)).toBe('引用内容已被撤回');
    for (const im of [a, b]) expect(JSON.stringify(im.debugExport())).not.toContain('ZXQ-QUO-1');
  });
});

describe('群：提及和群主、管理员撤回 × 真实服务端', () => {
  it('TC-MEN-01-01、TC-MEN-03-07、TC-RCL-02-04、TC-MEN-02-05、AC-RCL-02-5', async () => {
    const [o, a, m, nn] = [uid('o'), uid('a'), uid('m'), uid('n')];
    await users(o, a, m, nn);
    const groupId = uid('g');
    const convId = `group:${groupId}`;
    await srv.signed('POST', '/admin/groups', { groupId, name: groupId, members: [o, a, m, nn], owner: o });
    const ownerGate = new GateTransport();
    const owner = await login(o, client(ownerGate));
    await owner.setGroupAdmin(groupId, a, true);
    const [adm, mem, other] = [await login(a), await login(m), await login(nn)];
    for (const im of [owner, adm, mem, other]) {
      await until(() => im.conversations().some((c) => c.convId === convId), 'group in list');
    }
    await until(() => adm.conversations().find((c) => c.convId === convId)?.myRole === 'admin', 'admin role');

    // 成员搜索（F-MEN-01 规则 6）：userId 前缀。
    const found = await mem.searchGroupMembers(groupId, nn);
    expect(found.members.map((x) => x.userId)).toEqual([nn]);

    // TC-MEN-01-01：m @ n。n 的会话 mentionUnread=1（实时推算，重新登录后服务端也是 1）；o 没有。
    const conv = (im: IMClient) => im.conversations().find((c) => c.convId === convId);
    const at = await sent(mem, convId, `@${nn} 看一下`, { mentions: { userIds: [nn] } });
    const got = await until(() => byId(other, convId, at.msgId!), 'n receives');
    expect(got.body.mentions).toEqual({ userIds: [nn] });
    expect(conv(other)).toMatchObject({ mentionUnread: 1, firstMentionSeq: at.seq });
    await until(() => byId(owner, convId, at.msgId!), 'o receives');
    expect(conv(owner)!.mentionUnread ?? 0).toBe(0);
    const other2 = await login(nn);
    await until(() => conv(other2)?.mentionUnread === 1, 'server mentionUnread=1');

    // TC-MEN-03-07：对方撤回提及消息，n 的两个连接都在 5 秒内重新拉 convs，"[有人@我]" 消失。
    await mem.recall(convId, at.msgId!);
    for (const im of [other, other2]) await until(() => conv(im)?.mentionUnread === 0, 'mention cleared', 5_000);

    // TC-RCL-02-04：a 撤回 m 的消息（最后一条），a、m、n 的聊天页和列表摘要。
    const target = await sent(mem, convId, 'ZXQ-RCL-2 成员的消息');
    for (const im of [adm, other]) await until(() => byId(im, convId, target.msgId!), 'loaded');
    expect(adm.canRecall(byId(adm, convId, target.msgId!)!)).toBe(true);
    await adm.recall(convId, target.msgId!);
    const want: Array<[IMClient, string]> = [
      [adm, `你撤回了 ${m} 的一条消息`],
      [mem, `${a}撤回了你的一条消息`],
      [other, `${a}撤回了一条成员消息`],
    ];
    for (const [im, text] of want) {
      const msg = await until(() => byId(im, convId, target.msgId!)?.recalled && byId(im, convId, target.msgId!), text);
      expect(msg.recalledBy).toBe(a);
      expect(im.recallText(convId, msg)).toBe(text);
      const last = conv(im)!.lastMsg!;
      expect(last).toMatchObject({ msgId: target.msgId, deleted: true, recalled: true, recalledBy: a });
      expect(im.recallText(convId, last)).toBe(text);
      expect(JSON.stringify(im.debugExport())).not.toContain('ZXQ-RCL-2');
    }

    // AC-RCL-02-5：管理员撤回群主的消息，4030，提示"你没有权限撤回这条消息"，消息不变。
    const om = await sent(owner, convId, '群主的消息');
    await until(() => byId(adm, convId, om.msgId!), 'admin loaded');
    expect(adm.messageActions(byId(adm, convId, om.msgId!)!)).toContain('recall');
    const err = (await adm.recall(convId, om.msgId!).catch((e: unknown) => e)) as IMError;
    expect(err.code).toBe(4030);
    expect(messageFor('recall', err.code)).toBe('你没有权限撤回这条消息');
    expect(byId(adm, convId, om.msgId!)!.body.text).toBe('群主的消息');

    // TC-MEN-02-05：每小时 1 次（测试配置），第二次 @ 所有人 4293：失败，不自动重发。
    await sent(owner, convId, '@所有人 第一次', { mentions: { all: true } });
    const r = owner.send(convId, '@所有人 第二次', { mentions: { all: true } });
    if (!r.ok) throw new Error('send');
    const failed = await until(
      () => owner.messages(convId).find((x) => x.clientMsgId === r.message.clientMsgId && x.status === 'failed'),
      '4293',
    );
    expect(failed.error).toBe(4293);
    expect(messageFor('send', 4293)).toBe('@所有人次数已用完');
    ownerGate.sent = [];
    ownerGate.cut();
    await until(() => owner.state !== 'connected', 'owner offline');
    ownerGate.offline = false;
    await until(() => owner.state === 'connected', 'owner back online');
    await new Promise((res) => setTimeout(res, 300));
    expect(ownerGate.sent.filter((f) => f.cmd === 'send')).toEqual([]);
    expect(owner.messages(convId).find((x) => x.clientMsgId === r.message.clientMsgId)).toMatchObject({
      status: 'failed',
      error: 4293,
    });
  });
});
