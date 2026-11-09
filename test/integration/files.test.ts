// FE-630 对真实 im-server（IM_FILES_ENABLED=1）+ 假 S3（fake_s3.py）的集成测试：
// AC-FILE-02-1、03-1 的 sdk-ts 部分（发、收、取地址、下载内容一致），4292 和取消的真实路径，日志里没有签名和文件名。
// 本地结果，CI 不运行。假 S3 只验调度逻辑，不证明厂商行为（TC-FILE 通用约定）。
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileClient,
  IMClient,
  StaticTokenAuth,
  c2cConvId,
  groupConvId,
  type FileUrlResult,
  type Logger,
  type ProcessedImage,
} from '../../src/index.js';
import { startFakeS3, startServer, type FakeS3, type RunningServer } from './server.js';

let s3: FakeS3;
let srv: RunningServer;
const clients: IMClient[] = [];
const logs: string[] = [];
const logger: Logger = {
  debug: (m) => logs.push(m),
  warn: (m) => logs.push(m),
  error: (m, e) => logs.push(`${m} ${String(e)}`),
};

beforeAll(async () => {
  s3 = await startFakeS3();
  srv = await startServer({ ...s3.env, IM_UPLOAD_DAILY_BYTES: String(40 << 20) });
});
afterAll(async () => {
  for (const c of clients) c.destroy();
  await srv?.stop();
  await s3?.stop();
  // AC-FILE-04-11：SDK 的日志里没有预签名地址、签名和文件名特征串。
  const all = logs.join('\n');
  expect(all).not.toContain('X-Amz');
  expect(all).not.toContain('127.0.0.1');
  expect(all).not.toContain('ZXQ-FILE');
});

async function until<T>(fn: () => T | undefined | false, what: string, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function login(userId: string): Promise<IMClient> {
  const token = await srv.token(userId);
  const files = new FileClient({ auth: new StaticTokenAuth(srv.httpURL, token), logger });
  const im = new IMClient({ url: srv.wsURL, browserEvents: false, files, logger });
  clients.push(im);
  im.connect(token);
  await until(() => im.state === 'connected' && im.userId === userId, `${userId} connected`);
  return im;
}

/** 只有 SOF0 段的 JPEG：服务端嗅探能读到宽高（不解码像素）。 */
function jpeg(width: number, height: number, size: number): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3];
  head.push(1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  const b = new Uint8Array(size);
  b.set(head);
  for (let i = head.length; i < size - 2; i++) b[i] = (i * 31) & 0xff;
  b.set([0xff, 0xd9], size - 2);
  return b;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function download(
  r: FileUrlResult | undefined,
): Promise<{ body: Uint8Array; type: string | null; disposition: string | null }> {
  if (!r?.url) throw new Error(`no url: code ${r?.code}`);
  const res = await fetch(r.url);
  expect(res.status).toBe(200);
  return {
    body: new Uint8Array(await res.arrayBuffer()),
    type: res.headers.get('content-type'),
    disposition: res.headers.get('content-disposition'),
  };
}

describe('SDK × 真实服务端 × 假 S3：图片和文件', () => {
  it('TC-FILE-02-01（sdk-ts）：u1 发 2 MiB jpeg，u2 收到 type=image，先取缩略图再取原图，两边 size、mime、宽高一致', async () => {
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'fu2' }] });
    const u1 = await login('fu1');
    const u2 = await login('fu2');
    const conv = c2cConvId('fu1', 'fu2');
    const original = jpeg(1920, 1080, 2 << 20);
    const thumb = jpeg(480, 270, 30_000);
    const img: ProcessedImage = {
      original: { data: original, mime: 'image/jpeg' },
      thumb: { data: thumb, mime: 'image/jpeg' },
      width: 1920,
      height: 1080,
    };
    const statuses: string[] = [];
    u1.on('messages', (id, list) => {
      const s = list[0]?.status;
      if (id === conv && s && statuses.at(-1) !== s) statuses.push(s);
    });
    u1.sendImage(conv, img);
    const sent = await until(() => u1.messages(conv).find((m) => m.status === 'sent'), 'u1 sent');
    expect(statuses).toEqual(['uploading', 'sending', 'sent']);
    const got = await until(() => u2.messages(conv)[0], 'u2 receives');
    expect(got.type).toBe('image');
    expect(got.body.image).toEqual(sent.body.image);
    expect(got.body.image).toMatchObject({ width: 1920, height: 1080, size: original.length, mime: 'image/jpeg' });
    const fileId = got.body.image!.fileId;
    const [t] = await u2.getFileUrls([{ fileId, variant: 'thumb' }]);
    const tb = await download(t);
    expect(sha256(tb.body)).toBe(sha256(thumb));
    const [o] = await u2.getFileUrls([{ fileId, variant: 'original' }]);
    const ob = await download(o);
    expect(sha256(ob.body)).toBe(sha256(original));
    expect(ob.type).toBe('image/jpeg');
    expect(u2.conversations().find((c) => c.convId === conv)?.lastMsg).toMatchObject({ type: 'image' });
  });

  it('TC-FILE-03-01（sdk-ts）：群里发 5 MiB pdf，成员下载 SHA-256 相同，附件形式下载，文件名不进日志', async () => {
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'gu2' }, { userId: 'gu3' }] });
    const u1 = await login('gu1');
    const u2 = await login('gu2');
    const groupId = 'gfiles';
    await srv.admin('POST', '/admin/groups', { groupId, name: groupId, members: ['gu1', 'gu2', 'gu3'] });
    const conv = groupConvId(groupId);
    await until(() => u1.conversations().some((c) => c.convId === conv), 'u1 sees group');
    const pdf = new Uint8Array(5 << 20);
    pdf.set(new TextEncoder().encode('%PDF-1.7\n'));
    for (let i = 9; i < pdf.length; i++) pdf[i] = (i * 7) & 0xff;
    const name = 'ZXQ-FILE-报告.pdf';
    u1.sendFile(conv, { data: pdf, name, mime: 'application/pdf' });
    await until(() => u1.messages(conv).find((m) => m.type === 'file' && m.status === 'sent'), 'u1 sent');
    const got = await until(() => u2.messages(conv).find((m) => m.type === 'file'), 'u2 receives file');
    expect(got.body.file).toMatchObject({ name, size: pdf.length, mime: 'application/pdf' });
    const [r] = await u2.getFileUrls([{ fileId: got.body.file!.fileId, variant: 'original' }]);
    const d = await download(r);
    expect(sha256(d.body)).toBe(sha256(pdf));
    expect(d.disposition).toMatch(/^attachment;/);
    expect(u2.conversations().find((c) => c.convId === conv)?.lastMsg?.text ?? '').not.toContain('ZXQ');
  });

  it('不是参与者：这一项 code=4048，和不存在的 fileId 相同（AC-FILE-04-1 在 SDK 上的样子）', async () => {
    const u1 = await login('xu1');
    const u3 = await login('xu3');
    const conv = c2cConvId('xu1', 'xu2');
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'xu2' }] });
    u1.sendImage(conv, {
      original: { data: jpeg(100, 100, 2000), mime: 'image/jpeg' },
      thumb: { data: jpeg(50, 50, 1000), mime: 'image/jpeg' },
      width: 100,
      height: 100,
    });
    const sent = await until(() => u1.messages(conv).find((m) => m.status === 'sent'), 'sent');
    const res = await u3.getFileUrls([
      { fileId: sent.body.image!.fileId, variant: 'original' },
      { fileId: 'nonexistent123', variant: 'original' },
    ]);
    expect(res.map((r) => r.code)).toEqual([4048, 4048]);
  });

  it('TC-FILE-01-12（真实）：当天额度用完，申请上传 429 / 4292，消息失败、不重试', async () => {
    const u1 = await login('qu1');
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'qu2' }] });
    const conv = c2cConvId('qu1', 'qu2');
    // 额度 40 MiB：两个 20 MiB 文件用完，第三个申请就超
    for (let i = 0; i < 2; i++) {
      const big = new Uint8Array(20 << 20);
      big.set(new TextEncoder().encode('%PDF-1.4\n'));
      u1.sendFile(conv, { data: big, name: `q${i}.pdf`, mime: 'application/pdf' });
    }
    await until(() => u1.messages(conv).filter((m) => m.status === 'sent').length === 2, 'two sent', 20_000);
    u1.sendFile(conv, { data: new Uint8Array(10), name: 'x.txt', mime: 'text/plain' });
    const failed = await until(() => u1.messages(conv).find((m) => m.status === 'failed'), 'failed');
    expect(failed.error).toBe(4292);
    await new Promise((r) => setTimeout(r, 1500));
    expect(u1.messages(conv).filter((m) => m.status !== 'sent')).toHaveLength(1);
  });

  it('TC-FILE-02-05（真实）：PUT 进行中取消，消息消失，服务端的上传被取消（之后 complete 404）', async () => {
    const u1 = await login('cu1');
    await srv.admin('POST', '/admin/users/import', { users: [{ userId: 'cu2' }] });
    const conv = c2cConvId('cu1', 'cu2');
    let fileId = '';
    const files = (u1 as unknown as { files: FileClient }).files;
    const realCreate = files.createUpload.bind(files);
    files.createUpload = async (req, signal) => {
      const r = await realCreate(req, signal);
      fileId = r.fileId;
      return r;
    };
    const ac = new AbortController();
    u1.sendImage(
      conv,
      {
        original: { data: jpeg(800, 600, 8 << 20), mime: 'image/jpeg' },
        thumb: { data: jpeg(80, 60, 1000), mime: 'image/jpeg' },
        width: 800,
        height: 600,
      },
      { signal: ac.signal },
    );
    await until(() => fileId, 'upload granted');
    ac.abort();
    expect(u1.messages(conv)).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    const token = await srv.token('cu1');
    const res = await fetch(`${srv.httpURL}/v1/files/${fileId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});
