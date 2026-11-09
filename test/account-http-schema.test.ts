// TC-CHAT-90-09（AC-CHAT-90-10，sdk-ts 部分）：账号接口的请求和 http-client.schema.json 一致。
import { describe, expect, it } from 'vitest';
import { accountSetup, endpointKey, httpSchema, httpValidator } from './support/account.js';
import { flush } from './helpers.js';

describe('TC-CHAT-90-09 http-client.schema.json', () => {
  it('AccountClient 的 14 个接口和 FileClient 的 4 个文件接口都在 endpoints 里，请求体符合 Schema', async () => {
    const h = accountSetup();
    h.session(1, 24 * 3_600_000);
    const a = h.account;
    const calls: Array<Promise<unknown>> = [
      a.getConfig(),
      a.listEvents(),
      a.updateProfile({ nickname: '小明' }),
      a.regenerateRecoveryCode('Password-1'),
      a.ackRecoveryCode(2),
      a.cancelDelete('alice_1', 'Password-1'),
      // 文件接口（FE-630，F-FILE-01、04）：经过 AccountClient.authorized 带 Bearer。
      h.files.createUpload({
        kind: 'image',
        name: 'a.jpg',
        size: 10,
        mime: 'image/jpeg',
        thumb: { size: 5, mime: 'image/jpeg' },
      }),
      h.files.complete('F1'),
      h.files.cancelUpload('F1'),
      h.files.getFileUrls([{ fileId: 'F1', variant: 'thumb' }]),
    ];
    calls.forEach((p) => p.catch(() => undefined));
    await flush();
    for (const c of [...h.http.calls]) c.respond(200, {});
    await flush();
    // 串行队列里的，每个都放行再看下一个。
    const inQueue: Array<() => Promise<unknown>> = [
      () => a.register({ username: 'alice_1', password: 'Password-1', inviteCode: 'INV', nickname: '小明' }),
      () => a.login('alice_1', 'Password-1'),
      () => a.recover('alice_1', 'CODE', 'Password-2'),
      () => a.changePassword('Password-1', 'Password-2'),
      () => a.logoutOthers('Password-1'),
      () => a.requestDelete('Password-1'),
    ];
    for (const run of inQueue) {
      void run().catch(() => undefined);
      await flush();
      const call = h.http.pending[0]!;
      call.respondError(400, 4000);
      await flush();
    }
    const logout = a.logout();
    await flush();
    h.http.pending[0]!.respond(200, {});
    await logout;
    const seen = new Set(h.http.calls.map((c) => endpointKey(c.req.method, c.path) ?? `${c.req.method} ${c.path}`));
    const missing = Object.keys(httpSchema.endpoints).filter((e) => !seen.has(e) && !e.endsWith('/token/refresh'));
    expect(missing).toEqual([]);
    expect(h.badRequests).toEqual([]);
  });

  it('校验器确实会拒绝不合格的响应', () => {
    expect(httpValidator.errors({ userId: 'x' }, '#/$defs/AuthResponse').length).toBeGreaterThan(0);
  });
});
