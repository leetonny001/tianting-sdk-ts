// FE-690（C6）× 真实服务端（IM_MOD_ENABLED=1）：举报、4510。只用特征串，没有真实敏感词。
// 服务端随 BE-492～496：在那之前 features.moderation 是 false、report 返回 4001、词库接口不存在（调用方的
// moderation.words scope 不认识，第二个服务端启动失败），这里的用例如实失败，不跳过、不放宽。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccountClient,
  AccountError,
  IMClient,
  IMError,
  WebSocketTransport,
  c2cConvId,
  type AccountSession,
  type Message,
  type SessionStore,
  type TransportConnection,
  type TransportHandlers,
} from '../../src/index.js';
import { startServer, type RunningServer } from './server.js';

// 只给集成测试用的证据密钥（32 字节，base64），和 IM_QUARANTINE_KEY、JWT 密钥都不同。
const MOD_ENV = {
  IM_MOD_ENABLED: '1',
  IM_REPORT_KEY: Buffer.from('sdk-it-report-key-0123456789abcd').toString('base64'),
};
const WORD = 'zxqmodword'; // 特征词
const ID = /^[A-Za-z0-9_-]{1,64}$/;

async function until<T>(fn: () => T | undefined | false | null, what: string, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 记下收到的每一帧（ack、pong 之外的就是推送和事件）。 */
class RecordingTransport extends WebSocketTransport {
  readonly inbound: Array<{ cmd: string; at: number }> = [];
  override open(url: string, h: TransportHandlers): TransportConnection {
    return super.open(url, {
      ...h,
      onMessage: (text) => {
        try {
          this.inbound.push({ cmd: String((JSON.parse(text) as { cmd?: unknown }).cmd), at: Date.now() });
        } catch {
          /* 交给 SDK 处理 */
        }
        h.onMessage(text);
      },
    });
  }
  pushedSince(t: number): string[] {
    return this.inbound.filter((f) => f.at >= t && f.cmd !== 'ack' && f.cmd !== 'pong').map((f) => f.cmd);
  }
}

let n = 0;
const uid = (base: string) => `${base}${Date.now().toString(36)}${n++}`;

function harness(getSrv: () => RunningServer) {
  const clients: IMClient[] = [];
  const transports = new Map<IMClient, RecordingTransport>();
  return {
    clients,
    transportOf: (im: IMClient) => transports.get(im)!,
    async login(userId: string): Promise<IMClient> {
      const transport = new RecordingTransport();
      const im = new IMClient({
        url: getSrv().wsURL,
        browserEvents: false,
        transport,
        timings: { backoffBaseMs: 50, backoffMaxMs: 100 },
      });
      clients.push(im);
      transports.set(im, transport);
      im.connect(await getSrv().token(userId));
      await until(() => im.state === 'connected' && im.userId === userId, `${userId} connected`);
      return im;
    },
    async users(...ids: string[]): Promise<void> {
      await getSrv().admin('POST', '/admin/users/import', { users: ids.map((userId) => ({ userId })) });
    },
  };
}

async function sent(im: IMClient, convId: string, text: string): Promise<Message> {
  const r = im.send(convId, text);
  if (!r.ok) throw new Error('send');
  return until(
    () => im.messages(convId).find((m) => m.clientMsgId === r.message.clientMsgId && m.status === 'sent'),
    `sent ${text}`,
  );
}

describe('举报 × 真实服务端（BE-495）', () => {
  let srv: RunningServer;
  const t = harness(() => srv);
  beforeAll(async () => {
    srv = await startServer(MOD_ENV);
  });
  afterAll(async () => {
    for (const c of t.clients) c.destroy();
    await srv?.stop();
  });

  it('backend-chat 第 96 条：GET /v1/config 的 features.moderation 读到 true', async () => {
    const cfg = await new AccountClient({ baseUrl: srv.httpURL, platform: 'web' }).getConfig();
    expect(cfg.features.moderation).toBe(true);
  });

  it('TC-MOD-03-01（AC-MOD-03-1 的客户端侧）：u2 举报 u1 的单聊消息（abuse）成功，返回 reportId；2 秒内 u1、u2 都收不到任何帧；重复提交返回同一个 reportId', async () => {
    const [u1, u2] = [uid('ra'), uid('rb')];
    await t.users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const [a, b] = [await t.login(u1), await t.login(u2)];
    const m = await sent(a, conv, 'ZXQ-RPT-3 被举报的消息');
    await until(() => b.conversations().find((c) => c.convId === conv), 'u2 has conv');
    await sleep(300); // 发送带来的推送先收完
    const t0 = Date.now();
    const id = await b.report({
      targetType: 'message',
      convId: conv,
      msgIds: [m.msgId!],
      reason: 'abuse',
      note: 'ZXQ-RPT-NOTE',
    });
    expect(id).toMatch(ID);
    await sleep(2_000);
    expect(t.transportOf(a).pushedSince(t0)).toEqual([]);
    expect(t.transportOf(b).pushedSince(t0)).toEqual([]);
    expect(await b.report({ targetType: 'message', convId: conv, msgIds: [m.msgId!], reason: 'abuse' })).toBe(id);
  });

  it('举报用户、群：成功；非参与者举报消息、举报不存在的用户都是 4040 reportTargetInvalid（响应相同）', async () => {
    const [u1, u2, u3] = [uid('rc'), uid('rd'), uid('re')];
    await t.users(u1, u2, u3);
    const conv = c2cConvId(u1, u2);
    const [a, b, c] = [await t.login(u1), await t.login(u2), await t.login(u3)];
    const m = await sent(a, conv, 'ZXQ-RPT-4');
    await until(() => b.conversations().find((x) => x.convId === conv), 'u2 has conv');
    expect(await b.report({ targetType: 'user', userId: u1, reason: 'spam' })).toMatch(ID);
    const { groupId } = await a.createGroup({ name: 'ZXQ 举报群', members: [u2] });
    await until(() => b.conversations().find((x) => x.convId === `group:${groupId}`), 'u2 in group');
    expect(await b.report({ targetType: 'group', groupId, reason: 'illegal' })).toMatch(ID);

    const errOf = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e,
      );
    const e1 = await errOf(c.report({ targetType: 'message', convId: conv, msgIds: [m.msgId!], reason: 'abuse' }));
    const e2 = await errOf(c.report({ targetType: 'user', userId: uid('nobody'), reason: 'abuse' }));
    for (const e of [e1, e2]) {
      expect(e).toBeInstanceOf(IMError);
      expect(e).toMatchObject({ code: 4040, reason: 'reportTargetInvalid' });
    }
    expect((e1 as IMError).message).toBe((e2 as IMError).message);
  });
});

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

describe('4510 × 真实服务端（BE-493、BE-494）', () => {
  let srv: RunningServer;
  const t = harness(() => srv);
  beforeAll(async () => {
    srv = await startServer({ ...MOD_ENV, IM_REGISTER_MODE: 'invite' }, { extraScopes: ['moderation.words'] });
    await srv.signed('POST', '/admin/moderation/words', { word: WORD });
  });
  afterAll(async () => {
    for (const c of t.clients) c.destroy();
    await srv?.stop();
  });

  it('TC-MOD-02-09（AC-MOD-02-9 的 SDK 部分）：发送含特征词的消息：标记失败、error=4510、不能重发；对方收不到，服务端没有保存', async () => {
    const [u1, u2] = [uid('ba'), uid('bb')];
    await t.users(u1, u2);
    const conv = c2cConvId(u1, u2);
    const [a, b] = [await t.login(u1), await t.login(u2)];
    await sent(a, conv, '先发一条正常的');
    const failed: unknown[] = [];
    a.on('sendFailed', (...x) => failed.push(x));
    // 词库 10 秒内生效（AC-MOD-01-1）：每 500 毫秒发一条新的，直到被拦截。
    let blocked: Message | undefined;
    for (const deadline = Date.now() + 11_000; !blocked && Date.now() < deadline;) {
      const r = a.send(conv, `含 ${WORD} 的消息 ${Date.now()}`);
      if (!r.ok) throw new Error('send');
      const m = await until(
        () => a.messages(conv).find((x) => x.clientMsgId === r.message.clientMsgId && x.status !== 'sending'),
        'send settled',
      );
      if (m.status === 'failed') blocked = m;
      else await sleep(500);
    }
    expect(blocked).toMatchObject({ status: 'failed', error: 4510 });
    expect(blocked!.errorReason).toBeUndefined();
    expect(a.canRetry(blocked!)).toBe(false);
    expect(failed.at(-1)).toEqual([conv, blocked!.clientMsgId, 4510]);
    a.retry(conv, blocked!.clientMsgId);
    await sleep(2_000);
    expect(a.messages(conv).find((x) => x.clientMsgId === blocked!.clientMsgId)).toMatchObject({ status: 'failed' });
    expect(b.messages(conv).some((x) => x.clientMsgId === blocked!.clientMsgId)).toBe(false);
    await b.loadHistory(conv);
    expect(b.messages(conv).some((x) => x.clientMsgId === blocked!.clientMsgId)).toBe(false);
  });

  it('建群的群名含特征词：IMError 4510 原样抛出，不带 details', async () => {
    const [u1, u2] = [uid('bc'), uid('bd')];
    await t.users(u1, u2);
    const a = await t.login(u1);
    const e = await a.createGroup({ name: `群 ${WORD}`, members: [u2] }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(IMError);
    expect(e).toMatchObject({ code: 4510, details: undefined });
  });

  it('注册的昵称、改昵称含特征词：AccountError {status 451, code 4510}，不带 details', async () => {
    const invite = async () => {
      const r = await srv.signed('POST', '/admin/invites', {
        count: 1,
        maxUses: 1,
        expiresAt: Date.now() + 86_400_000,
      });
      return (r['invites'] as Array<{ code: string }>)[0]!.code;
    };
    const password = 'Tt-good-pass-2026!';
    const username = `mod_${Date.now().toString(36)}`;
    const account = new AccountClient({ baseUrl: srv.httpURL, platform: 'web', store: new Store() });
    const e1 = await account
      .register({ username, password, nickname: `昵称${WORD}`, inviteCode: await invite() })
      .catch((x: unknown) => x);
    expect(e1).toBeInstanceOf(AccountError);
    expect(e1).toMatchObject({ status: 451, code: 4510, details: undefined });
    await account.register({ username, password, nickname: '正常昵称', inviteCode: await invite() });
    const e2 = await account.updateProfile({ nickname: `新${WORD}` }).catch((x: unknown) => x);
    expect(e2).toBeInstanceOf(AccountError);
    expect(e2).toMatchObject({ status: 451, code: 4510, details: undefined });
  });
});
