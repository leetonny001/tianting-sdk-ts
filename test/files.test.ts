// FE-630：图片和文件（PRD-chat F-FILE-01、04、06、07，F-RCL-03 规则 2、2a）。
// 假 HTTP + 假对象存储（FakeUpload）+ FakeTransport + 假时钟。测试名带 TC-FILE 编号。本地单测结果，CI 不运行。
import { afterEach, describe, expect, it } from 'vitest';
import { type Message, type ProcessedImage } from '../src/index.js';
import { conv, flush, msg } from './helpers.js';
import { HOUR, USER, accountSetup, jwt, type AccountHarness } from './support/account.js';
import type { FakeHttpCall } from '../src/testing/index.js';

const DAY = 24 * HOUR;
const AB = `c2c:${USER}:bob`;
const G1 = 'group:g1';
const UPLOADS = '/v1/files/uploads';
const URLS = '/v1/files/urls';
const SIG = 'X-Amz-Signature=deadbeef';
const SECRET_NAME = 'ZXQ-FILE-NAME.pdf';

let current: AccountHarness | null = null;
afterEach(() => {
  expect(current?.badRequests ?? []).toEqual([]); // 每个请求体都符合 http-client.schema.json
  // AC-FILE-04-11：日志里没有预签名地址、签名、文件名。
  const logs = (current?.logs ?? []).join('\n');
  expect(logs).not.toContain('X-Amz');
  expect(logs).not.toContain('s3.test');
  expect(logs).not.toContain('ZXQ-FILE');
  current = null;
});

async function online(): Promise<{ h: AccountHarness; c: Awaited<ReturnType<AccountHarness['online']>> }> {
  const h = accountSetup();
  current = h;
  h.session(1, DAY);
  const c = await h.online();
  return { h, c };
}

function image(n = 1): ProcessedImage {
  return {
    original: { data: new Uint8Array(1000 * n), mime: 'image/jpeg' },
    thumb: { data: new Uint8Array(100), mime: 'image/jpeg' },
    width: 4000,
    height: 3000,
  };
}

const put = (key: string) => ({
  url: `https://s3.test/chat/tmp/${key}?${SIG}`,
  headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '1000' },
  expiresAt: 1,
});

function status(h: AccountHarness, convId = AB): string[] {
  return h.im
    .messages(convId)
    .map(
      (m) => `${m.clientMsgId}:${m.status}${m.error !== undefined ? `(${m.error})` : ''}${m.seq ? `#${m.seq}` : ''}`,
    );
}

/** 回复第 i 个（默认最后一个）申请上传。 */
function grant(h: AccountHarness, fileId: string, call?: FakeHttpCall, thumb = true): void {
  (call ?? h.http.to(UPLOADS).at(-1)!).respond(200, {
    fileId,
    put: put(`${fileId}-o`),
    ...(thumb ? { thumbPut: put(`${fileId}-t`) } : {}),
  });
}

/** 走完一个文件的上传：申请 → PUT 原图（缩略图）→ complete。 */
async function uploadOk(h: AccountHarness, fileId: string, thumb = true): Promise<void> {
  await flush();
  grant(h, fileId, undefined, thumb);
  await flush();
  h.upload.pending[0]!.respond(200);
  await flush();
  if (thumb) {
    h.upload.pending[0]!.respond(200);
    await flush();
  }
  h.http
    .last(`/v1/files/${fileId}/complete`)
    .respond(200, { fileId, size: 1000, mime: 'image/jpeg', width: 4000, height: 3000 });
  await flush();
}

const sends = (c: { frames(): Array<{ cmd: string; data?: Record<string, unknown> }> }) =>
  c.frames().filter((f) => f.cmd === 'send');

describe('发图片：处理中 → 上传中 → 待发送 → 发送中 → 已发送（F-FILE-07 规则 1）', () => {
  it('处理好之后申请、PUT 原图和缩略图（签入的头原样带上）、complete，只发 fileId；ack 后已发送，进度到 100%', async () => {
    const { h, c } = await online();
    let resolve!: (p: ProcessedImage) => void;
    const progress: Array<[number, number]> = [];
    const m = h.im.sendImage(AB, () => new Promise((r) => (resolve = r)), {
      onProgress: (s, t) => progress.push([s, t]),
    });
    expect(m.status).toBe('processing');
    expect(status(h)).toEqual(['cid-0001:processing']);
    await flush();
    expect(h.http.to(UPLOADS)).toHaveLength(0);
    resolve(image());
    await flush();
    expect(status(h)).toEqual(['cid-0001:uploading']);
    expect(h.im.messages(AB)[0]!.body.image).toEqual({
      fileId: '',
      width: 4000,
      height: 3000,
      size: 1000,
      mime: 'image/jpeg',
    });
    expect(h.http.last(UPLOADS).json).toEqual({
      kind: 'image',
      name: 'image',
      size: 1000,
      mime: 'image/jpeg',
      thumb: { size: 100, mime: 'image/jpeg' },
    });
    expect(h.http.last(UPLOADS).bearer).toBe(jwt('sid1', 1));
    grant(h, 'F1');
    await flush();
    expect(h.upload.calls).toHaveLength(1); // 并发 1：原图完了才传缩略图
    expect(h.upload.calls[0]!.url).toContain('F1-o');
    expect(h.upload.calls[0]!.headers).toEqual({ 'Content-Type': 'image/jpeg', 'Content-Length': '1000' });
    h.upload.calls[0]!.sent(500);
    h.upload.calls[0]!.respond(200);
    await flush();
    expect(h.upload.calls[1]!.url).toContain('F1-t');
    h.upload.calls[1]!.respond(200);
    await flush();
    expect(progress).toEqual([
      [500, 1100],
      [1000, 1100],
      [1100, 1100],
    ]);
    expect(sends(c)).toHaveLength(0);
    h.http
      .last('/v1/files/F1/complete')
      .respond(200, { fileId: 'F1', size: 990, mime: 'image/jpeg', width: 4000, height: 3000 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sending']);
    expect(c.last('send').data).toEqual({
      convType: 'c2c',
      to: 'bob',
      clientMsgId: 'cid-0001',
      type: 'image',
      body: { image: { fileId: 'F1' } },
    });
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 9 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1']);
    expect(h.im.messages(AB)[0]!.body.image).toEqual({
      fileId: 'F1',
      width: 4000,
      height: 3000,
      size: 990,
      mime: 'image/jpeg',
    });
    expect(h.im.conversations()[0]!.lastMsg).toMatchObject({ type: 'image', text: '' });
    expect(h.im.pendingCount()).toBe(0);
  });

  it('上传中的时间不算 10 秒发送超时（规则 8）', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    h.clock.advance(60_000); // PUT 慢：一分钟还在传
    await flush();
    expect(status(h)).toEqual(['cid-0001:uploading']);
    h.upload.pending[0]!.respond(200);
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
    h.http
      .last('/v1/files/F1/complete')
      .respond(200, { fileId: 'F1', size: 1000, mime: 'image/jpeg', width: 1, height: 1 });
    await flush();
    h.clock.advance(9_999);
    expect(status(h)).toEqual(['cid-0001:sending']);
    h.clock.advance(1);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(timeout)']);
    expect(sends(c)).toHaveLength(1);
  });

  it('发文件：kind=file，没有缩略图，文件名只在请求体里', async () => {
    const { h, c } = await online();
    h.im.sendFile(G1, { data: new Uint8Array(5000), name: SECRET_NAME, mime: 'application/pdf' });
    await flush();
    expect(h.http.last(UPLOADS).json).toEqual({ kind: 'file', name: SECRET_NAME, size: 5000, mime: 'application/pdf' });
    grant(h, 'F9', undefined, false);
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
    expect(h.upload.calls).toHaveLength(1);
    h.http.last('/v1/files/F9/complete').respond(200, { fileId: 'F9', size: 5000, mime: 'application/pdf' });
    await flush();
    expect(c.last('send').data).toMatchObject({
      convType: 'group',
      to: 'g1',
      type: 'file',
      body: { file: { fileId: 'F9' } },
    });
    c.ack('send', { msgId: 'm1', convId: G1, seq: 1, ts: 9 });
    await flush();
    expect(h.im.messages(G1)[0]).toMatchObject({
      status: 'sent',
      body: { file: { fileId: 'F9', name: SECRET_NAME, size: 5000, mime: 'application/pdf' } },
    });
  });

  it('App 处理图片失败：error=process，不申请上传', async () => {
    const { h } = await online();
    const failed: unknown[] = [];
    h.im.on('sendFailed', (_c, _id, e) => failed.push(e));
    h.im.sendImage(AB, () => Promise.reject(new Error('decode')));
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(process)']);
    expect(failed).toEqual(['process']);
    expect(h.http.to(UPLOADS)).toHaveLength(0);
  });

  it('complete 之后断线：待发送（queued），连上后自动发一次（规则 3）', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
    c.drop(1006);
    h.http
      .last('/v1/files/F1/complete')
      .respond(200, { fileId: 'F1', size: 1000, mime: 'image/jpeg', width: 1, height: 1 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:queued']);
    h.clock.advance(1_000);
    await flush();
    const c2 = await h.login(USER);
    expect(c2.last('send').data).toMatchObject({ clientMsgId: 'cid-0001', body: { image: { fileId: 'F1' } } });
    expect(h.http.to(UPLOADS)).toHaveLength(1);
  });
});

describe('TC-FILE-01-12、01-17：4292、uploadPendingLimit 不自动重试', () => {
  it('4292：标记失败，只有 1 个申请请求（AC-FILE-01-12）', async () => {
    const { h } = await online();
    const failed: unknown[] = [];
    h.im.on('sendFailed', (_c, _id, e) => failed.push(e));
    h.im.sendImage(AB, image());
    await flush();
    h.http.last(UPLOADS).respondError(429, 4292);
    await flush();
    h.clock.advance(5_000);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(4292)']);
    expect(failed).toEqual([4292]);
    expect(h.http.to(UPLOADS)).toHaveLength(1);
  });

  it('4290 uploadPendingLimit：失败带 reason，只有 1 个请求；用户取消上传时发 DELETE（AC-FILE-01-17）', async () => {
    const { h, c } = await online();
    h.im.sendFile(AB, { data: new Uint8Array(10), name: 'a.txt', mime: 'text/plain' });
    await flush();
    h.http.last(UPLOADS).respondError(429, 4290, { reason: 'uploadPendingLimit' });
    await flush();
    h.clock.advance(5_000);
    await flush();
    expect(h.im.messages(AB)[0]).toMatchObject({ status: 'failed', error: 4290, errorReason: 'uploadPendingLimit' });
    expect(h.http.to(UPLOADS)).toHaveLength(1);
    // 恢复后再发，上传中点取消
    const m = h.im.sendFile(AB, { data: new Uint8Array(10), name: 'b.txt', mime: 'text/plain' });
    await flush();
    grant(h, 'F2', undefined, false);
    await flush();
    expect(h.upload.pending).toHaveLength(1);
    expect(h.im.cancelUpload(AB, m.clientMsgId)).toBe(true);
    await flush();
    expect(h.upload.calls.at(-1)!.aborted).toBe(true);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE').map((x) => x.path)).toEqual(['/v1/files/uploads/F2']);
    expect(h.im.messages(AB).map((x) => x.clientMsgId)).toEqual(['cid-0001']);
    expect(sends(c)).toHaveLength(0);
  });
});

describe('TC-FILE-02-05 上传中取消：消息消失，不发 send，发 DELETE（AC-FILE-02-5）', () => {
  it('PUT 到一半取消；之后迟到的 PUT 结果和 complete 都不会让它回来', async () => {
    const { h, c } = await online();
    const abort = new AbortController();
    h.im.sendImage(AB, image(), { signal: abort.signal });
    await flush();
    grant(h, 'F1');
    await flush();
    h.upload.pending[0]!.sent(400);
    abort.abort();
    await flush();
    expect(h.im.messages(AB)).toEqual([]);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE').map((x) => x.path)).toEqual(['/v1/files/uploads/F1']);
    h.clock.advance(60_000);
    await flush();
    expect(sends(c)).toHaveLength(0);
    expect(h.http.to('/v1/files/F1/complete')).toHaveLength(0);
    expect(h.im.pendingCount()).toBe(0);
  });

  it('处理中取消：不申请上传；排在后面的照常上传', async () => {
    const { h } = await online();
    const m1 = h.im.sendImage(AB, () => new Promise<ProcessedImage>(() => {}));
    h.im.sendImage(AB, image());
    await flush();
    expect(h.http.to(UPLOADS)).toHaveLength(0);
    h.im.cancelUpload(AB, m1.clientMsgId);
    await flush();
    expect(h.http.to(UPLOADS)).toHaveLength(1);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE')).toHaveLength(0);
  });
});

describe('TC-FILE-07-02 complete 成功但 send 超时：手动重发不再上传（AC-FILE-07-2）', () => {
  it('复用同一 fileId、同一 clientMsgId；没有新的申请和 PUT', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    await uploadOk(h, 'F1');
    h.clock.advance(10_000);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(timeout)']);
    h.im.retry(AB, 'cid-0001');
    await flush();
    const s = sends(c);
    expect(s).toHaveLength(2);
    expect(s[1]!.data).toEqual(s[0]!.data);
    expect(h.http.to(UPLOADS)).toHaveLength(1);
    expect(h.upload.calls).toHaveLength(2);
    c.ack('send', { msgId: 'm1', convId: AB, seq: 1, ts: 9 });
    await flush();
    expect(status(h)).toEqual(['cid-0001:sent#1']);
  });
});

describe('TC-FILE-07-04 文字越过上传中的图片；3 张图按选择顺序（AC-FILE-07-4）', () => {
  it('文字先发出；3 张图依次上传（同时只有 1 个），send 顺序和选择顺序相同，seq 递增', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image(1));
    h.im.sendImage(AB, image(2));
    h.im.sendImage(AB, image(3));
    await flush();
    expect(h.http.to(UPLOADS)).toHaveLength(1);
    h.im.send(AB, '先到');
    expect(c.last('send').data).toMatchObject({ type: 'text', body: { text: '先到' } });
    c.ack('send', { msgId: 't', convId: AB, seq: 1, ts: 1 });
    await flush();
    expect(status(h)[0]).toBe('cid-0004:sent#1');
    for (const [i, id] of ['F1', 'F2', 'F3'].entries()) {
      expect(h.http.to(UPLOADS)).toHaveLength(i + 1);
      expect(h.http.last(UPLOADS).json['size']).toBe(1000 * (i + 1));
      expect(h.upload.pending.length).toBeLessThanOrEqual(1);
      await uploadOk(h, id);
      expect(c.last('send').data).toMatchObject({ clientMsgId: `cid-000${i + 1}`, body: { image: { fileId: id } } });
      c.ack('send', { msgId: `m${id}`, convId: AB, seq: i + 2, ts: 2 + i });
      await flush();
    }
    expect(status(h)).toEqual(['cid-0004:sent#1', 'cid-0001:sent#2', 'cid-0002:sent#3', 'cid-0003:sent#4']);
  });
});

describe('TC-FILE-07-07 弱网下 PUT 连续失败 5 次：不扣额度（AC-FILE-07-7）', () => {
  it('每次都是失败状态；不调 complete（只有 complete 成功才扣）；每次从头申请，放弃的上传发 DELETE', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    for (let i = 1; i <= 5; i++) {
      await flush();
      grant(h, `F${i}`);
      await flush();
      h.upload.pending[0]!.fail();
      await flush();
      expect(status(h)).toEqual([`cid-0001:failed(network)`]);
      if (i < 5) h.im.retry(AB, 'cid-0001');
    }
    expect(h.http.to(UPLOADS)).toHaveLength(5);
    expect(h.http.calls.filter((x) => x.path.endsWith('/complete'))).toHaveLength(0);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE')).toHaveLength(5);
    expect(sends(c)).toHaveLength(0);
  });

  it('对象存储拒绝 PUT（403，地址过期）同样按失败', async () => {
    const { h } = await online();
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    h.upload.pending[0]!.respond(403);
    await flush();
    expect(status(h)).toEqual([`cid-0001:failed(network)`]);
  });
});

describe('complete 返回 5032：退避重试 3 次再转失败（F-FILE-07 异常）', () => {
  async function toComplete(h: AccountHarness) {
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
    h.upload.pending[0]!.respond(200);
    await flush();
  }

  it('1、2、4 秒后重试，第 4 次还是 5032 就失败', async () => {
    const { h } = await online();
    await toComplete(h);
    const complete = () => h.http.to('/v1/files/F1/complete');
    for (const [i, wait] of [1_000, 2_000, 4_000].entries()) {
      complete().at(-1)!.respondError(503, 5032, { reason: 'completeInProgress' });
      await flush();
      h.clock.advance(wait - 1);
      await flush();
      expect(complete()).toHaveLength(i + 1);
      h.clock.advance(1);
      await flush();
      expect(complete()).toHaveLength(i + 2);
    }
    complete().at(-1)!.respondError(503, 5032);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(5032)']);
    h.clock.advance(60_000);
    await flush();
    expect(complete()).toHaveLength(4);
  });

  it('第 3 次成功就继续发送', async () => {
    const { h, c } = await online();
    await toComplete(h);
    const complete = () => h.http.to('/v1/files/F1/complete');
    complete().at(-1)!.respondError(503, 5032);
    await flush();
    h.clock.advance(1_000);
    await flush();
    complete().at(-1)!.respondError(503, 5032);
    await flush();
    h.clock.advance(2_000);
    await flush();
    complete().at(-1)!.respond(200, { fileId: 'F1', size: 1, mime: 'image/jpeg', width: 1, height: 1 });
    await flush();
    expect(sends(c)).toHaveLength(1);
  });

  it('complete 4096（缩略图没传上）：失败，不重试', async () => {
    const { h } = await online();
    await toComplete(h);
    h.http.last('/v1/files/F1/complete').respondError(409, 4096);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(4096)']);
  });
});

describe('TC-FILE-07-10 send 返回 4096：有源的回到上传中重新上传（AC-FILE-07-10，RC2-23）', () => {
  it('新的 fileId 重新上传后发送成功，clientMsgId 不变，不占自动重发次数', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    await uploadOk(h, 'F1');
    c.ackError('send', 4096);
    await flush();
    expect(status(h)).toEqual(['cid-0001:uploading']);
    expect(h.im.messages(AB)[0]!.body.image!.fileId).toBe('');
    await uploadOk(h, 'F2');
    expect(c.last('send').data).toMatchObject({ clientMsgId: 'cid-0001', body: { image: { fileId: 'F2' } } });
    // 连接断了，重连后还会自动补发一次（4096 那一次没占用）
    c.drop(1006);
    await flush();
    expect(status(h)).toEqual(['cid-0001:queued']);
    h.clock.advance(1_000);
    await flush();
    const c2 = await h.login(USER);
    expect(c2.last('send').data).toMatchObject({ clientMsgId: 'cid-0001' });
  });
});

describe('被踢、退出时的上传', () => {
  it('被踢：上传中的中止，标记失败（kicked）', async () => {
    const { h, c } = await online();
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    c.receive({ cmd: 'event', data: { type: 'kicked', reason: 'banned' } });
    c.drop(4012);
    await flush();
    expect(status(h)).toEqual(['cid-0001:failed(kicked)']);
    expect(h.upload.calls[0]!.aborted).toBe(true);
  });

  it('退出登录：中止上传，没完成的发 DELETE，源丢掉', async () => {
    const { h } = await online();
    h.im.sendImage(AB, image());
    await flush();
    grant(h, 'F1');
    await flush();
    h.im.disconnect();
    await flush();
    expect(h.upload.calls[0]!.aborted).toBe(true);
    expect(h.http.calls.filter((x) => x.req.method === 'DELETE').map((x) => x.path)).toEqual(['/v1/files/uploads/F1']);
    expect(h.im.messages(AB)).toEqual([]);
  });
});

describe('取地址：一屏合并成一批，地址缓存（F-FILE-04 规则 1、5、6，AC-FILE-04-10）', () => {
  const urlItem = (fileId: string, variant: 'thumb' | 'original') => ({
    fileId,
    variant,
    url: `https://s3.test/chat/final/${fileId}/${variant}?${SIG}`,
    expiresAt: 1_800_000_000_000 + 120_000,
  });

  it('同一个事件循环里 60 项分成 50 + 10 两批；第二次（没到期）不再请求', async () => {
    const { h } = await online();
    const items = Array.from({ length: 60 }, (_, i) => ({ fileId: `F${i}`, variant: 'thumb' as const }));
    const p = h.im.getFileUrls(items.slice(0, 30));
    const q = h.im.getFileUrls(items.slice(30));
    await flush();
    const calls = h.http.to(URLS);
    expect(calls.map((x) => (x.json['items'] as unknown[]).length)).toEqual([50, 10]);
    calls[0]!.respond(200, { items: items.slice(0, 50).map((i) => urlItem(i.fileId, 'thumb')) });
    calls[1]!.respond(200, {
      items: items.slice(50).map((i, k) => (k === 0 ? { ...i, code: 4048 } : urlItem(i.fileId, 'thumb'))),
    });
    const all = [...(await p), ...(await q)];
    expect(all[0]!.url).toContain('F0');
    expect(all[50]).toEqual({ fileId: 'F50', variant: 'thumb', code: 4048 });
    const again = await h.im.getFileUrls([items[1]!]);
    expect(again[0]!.url).toContain('F1');
    expect(h.http.to(URLS)).toHaveLength(2);
    // 剩余不到 15 秒时重新申请
    h.clock.advance(106_000);
    void h.im.getFileUrls([items[1]!]);
    await flush();
    expect(h.http.to(URLS)).toHaveLength(3);
  });

  it('同一项同时要两次只请求一次', async () => {
    const { h } = await online();
    const a = h.im.getFileUrls([{ fileId: 'F1', variant: 'original' }]);
    const b = h.im.getFileUrls([{ fileId: 'F1', variant: 'original' }]);
    await flush();
    expect(h.http.to(URLS)).toHaveLength(1);
    expect(h.http.last(URLS).json['items']).toEqual([{ fileId: 'F1', variant: 'original' }]);
    h.http.last(URLS).respond(200, { items: [urlItem('F1', 'original')] });
    expect((await a)[0]!.url).toBe((await b)[0]!.url);
  });

  it('TC-ACC-03-42 用原接口：在途的 /v1/files/urls 收到 4011，本地已有新 token 就用它重试一次（AC-ACC-03-42）', async () => {
    const { h } = await online();
    const p = h.im.getFileUrls([{ fileId: 'F1', variant: 'thumb' }]);
    await flush();
    const first = h.http.last(URLS);
    expect(first.bearer).toBe(jwt('sid1', 1));
    // 等响应期间刷新换了 token（gen 2）
    h.session(2, DAY);
    first.respondError(401, 4011, { reason: 'tokenSuperseded' });
    await flush();
    const calls = h.http.to(URLS);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.bearer).toBe(jwt('sid1', 2));
    expect(h.http.to('/v1/account/token/refresh')).toHaveLength(0);
    calls[1]!.respond(200, { items: [urlItem('F1', 'thumb')] });
    expect((await p)[0]!.url).toContain('F1');
  });
});

describe('TC-FILE-06-11 过期递增 modVer：只重拉这个会话，变"已过期"（AC-FILE-06-12，F-RCL-03 规则 2、2a）', () => {
  const img = (convId: string, seq: number, fileId: string, expired = false) => ({
    ...msg(convId, seq),
    type: 'image' as const,
    body: {
      image: { fileId, width: 10, height: 10, size: 100, mime: 'image/png', ...(expired ? { expired: true } : {}) },
    },
  });
  const fileMsg = (convId: string, seq: number, fileId: string, expired = false) => ({
    ...msg(convId, seq),
    type: 'file' as const,
    body: {
      file: {
        fileId,
        name: expired ? '' : SECRET_NAME,
        size: 100,
        mime: 'application/pdf',
        ...(expired ? { expired: true } : {}),
      },
    },
  });

  async function loaded() {
    const h = accountSetup();
    current = h;
    h.session(1, DAY);
    h.im.connect(h.account.tokenProvider);
    await flush();
    const c1 = await h.login(USER, [
      conv({ convId: AB, maxSeq: 2, modVer: 3 }),
      conv({ convId: G1, maxSeq: 1, modVer: 7 }),
    ]);
    void h.im.loadHistory(AB);
    await flush();
    c1.ack('sync', { messages: [img(AB, 1, 'F1'), fileMsg(AB, 2, 'F2')], hasMore: false });
    await flush();
    void h.im.loadHistory(G1);
    await flush();
    c1.ack('sync', { messages: [img(G1, 1, 'G1F')], hasMore: false });
    await flush();
    // F1 的地址已缓存
    const p = h.im.getFileUrls([{ fileId: 'F1', variant: 'thumb' }]);
    await flush();
    h.http.last(URLS).respond(200, {
      items: [{ fileId: 'F1', variant: 'thumb', url: `https://s3.test/x?${SIG}`, expiresAt: h.clock.now() + 120_000 }],
    });
    await p;
    return { h, c1 };
  }

  it('重连时 AB 的 modVer +1、G1 不变：只对 AB 发 sync；消息变成已过期，地址缓存清除，filesExpired 通知 App', async () => {
    const { h, c1 } = await loaded();
    const expiredEvents: string[][] = [];
    h.im.on('filesExpired', (ids) => expiredEvents.push(ids));
    c1.drop(1006);
    h.clock.advance(1_000);
    await flush();
    const before = h.transport.connections.length;
    const c2 = await h.login(USER, [
      conv({ convId: AB, maxSeq: 2, modVer: 4 }),
      conv({ convId: G1, maxSeq: 1, modVer: 7 }),
    ]);
    expect(h.transport.connections.length).toBe(before);
    const syncs = c2.frames().filter((f) => f.cmd === 'sync');
    expect(syncs.map((f) => f.data!['convId'])).toEqual([AB]);
    c2.ack('sync', { messages: [img(AB, 1, 'F1', true), fileMsg(AB, 2, 'F2', true)], hasMore: false });
    await flush();
    const [a, b] = h.im.messages(AB) as [Message, Message];
    expect(a.body.image).toMatchObject({ fileId: 'F1', expired: true });
    expect(b.body.file).toMatchObject({ fileId: 'F2', expired: true, name: '' });
    expect(expiredEvents.flat().sort()).toEqual(['F1', 'F2']);
    // 已知过期：不发申请地址的请求（AC-FILE-06-6 的 SDK 部分）
    const n = h.http.to(URLS).length;
    expect(await h.im.getFileUrls([{ fileId: 'F1', variant: 'thumb' }])).toEqual([
      { fileId: 'F1', variant: 'thumb', code: 4048 },
    ]);
    expect(h.http.to(URLS)).toHaveLength(n);
    // 缓存的地址也丢了：绕过 IMClient 直接问 FileClient 会重新请求
    void h.files.getFileUrls([{ fileId: 'F1', variant: 'thumb' }]);
    await flush();
    expect(h.http.to(URLS)).toHaveLength(n + 1);
    h.http.last(URLS).respond(200, { items: [{ fileId: 'F1', variant: 'thumb', code: 4048 }] });
    await flush();
    // 再重连，modVer 没变：不再重拉
    c2.drop(1006);
    h.clock.advance(1_000);
    await flush();
    const c3 = await h.login(USER, [
      conv({ convId: AB, maxSeq: 2, modVer: 4 }),
      conv({ convId: G1, maxSeq: 1, modVer: 7 }),
    ]);
    expect(c3.frames().filter((f) => f.cmd === 'sync')).toEqual([]);
    expect(JSON.stringify(h.im.debugExport())).not.toContain(SECRET_NAME);
  });

  it('迟到的旧 sync 应答带 expired=false 和文件名：不改回去（单调合并）', async () => {
    const { h, c1 } = await loaded();
    void h.im.loadHistory(AB); // 已经到底了：hasMoreHistory=false，不发请求
    const stale = c1.frames().filter((f) => f.cmd === 'sync').length;
    c1.receive({ cmd: 'msg', data: img(AB, 1, 'F1', true) }); // 先知道过期了
    await flush();
    expect(h.im.messages(AB)[0]!.body.image!.expired).toBe(true);
    c1.receive({ cmd: 'msg', data: img(AB, 1, 'F1', false) }); // 迟到的旧值
    await flush();
    expect(h.im.messages(AB)[0]!.body.image!.expired).toBe(true);
    // gap check / 翻页里迟到的应答同样不改回
    c1.receive({ cmd: 'msg', data: fileMsg(AB, 2, 'F2', true) });
    await flush();
    c1.receive({ cmd: 'msg', data: fileMsg(AB, 2, 'F2', false) });
    await flush();
    expect(h.im.messages(AB)[1]!.body.file).toMatchObject({ expired: true, name: '' });
    expect(c1.frames().filter((f) => f.cmd === 'sync').length).toBe(stale);
  });

  it('缺口太大只留最新一页（C-24）之后，向前翻页拿到的旧应答也不把 expired 改回去', async () => {
    const { h, c1 } = await loaded();
    c1.receive({ cmd: 'msg', data: img(AB, 1, 'F1', true) });
    await flush();
    c1.drop(1006);
    h.clock.advance(1_000);
    await flush();
    const c2 = await h.login(USER, [
      conv({ convId: AB, maxSeq: 500, modVer: 3 }),
      conv({ convId: G1, maxSeq: 1, modVer: 7 }),
    ]);
    expect(c2.last('sync').data).toMatchObject({ convId: AB, beforeSeq: 501 });
    c2.ack('sync', { messages: [msg(AB, 500)], hasMore: true });
    await flush();
    expect(h.im.messages(AB).map((m) => m.seq)).toEqual([500]);
    void h.im.loadHistory(AB, 1000);
    await flush();
    c2.ack('sync', { messages: [img(AB, 1, 'F1', false), msg(AB, 499)], hasMore: false });
    await flush();
    expect(h.im.messages(AB)[0]!.body.image!.expired).toBe(true);
  });

  it('删除也单调：迟到的旧应答带 deleted=false 和原文不恢复（deletedIds 优先）', async () => {
    const { h, c1 } = await loaded();
    c1.receive({ cmd: 'event', data: { type: 'msgDeleted', convId: AB, msgIds: [`${AB}#2`], seqs: [2] } });
    await flush();
    expect(h.im.messages(AB)[1]).toMatchObject({ deleted: true, body: {} });
    c1.receive({ cmd: 'msg', data: fileMsg(AB, 2, 'F2', false) });
    await flush();
    expect(h.im.messages(AB)[1]).toMatchObject({ deleted: true, body: {} });
    expect(JSON.stringify(h.im.debugExport())).not.toContain(SECRET_NAME);
  });

  it('老服务端（convs 没有 modVer）：仍然全部重拉', async () => {
    const { h, c1 } = await loaded();
    c1.drop(1006);
    h.clock.advance(1_000);
    await flush();
    const c2 = await h.login(USER, [conv({ convId: AB, maxSeq: 2 }), conv({ convId: G1, maxSeq: 1 })]);
    await flush();
    c2.ack('sync', { messages: [], hasMore: false });
    await flush();
    const syncs = c2.frames().filter((f) => f.cmd === 'sync');
    expect(syncs.map((f) => f.data!['convId']).sort()).toEqual([AB, G1].sort());
  });
});
