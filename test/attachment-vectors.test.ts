// TC-CHAT-90-13（AC-CHAT-90-15）：account-session.json 的 attachmentCases（附件发送状态机，PRD-chat F-FILE-07 规则 1、3、4）。
// 真实的 IMClient + FileClient + 假 HTTP + 假对象存储（FakeUpload）+ FakeTransport + 假时钟。
// persistence=true 的用例（冷启动）sdk-ts 跳过：H5 的 File 对象只在内存，刷新后消息不在（F-FILE-07 规则 2，AC-FILE-07-3）。
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Message, ProcessedImage } from '../src/index.js';
import { flush } from './helpers.js';
import { HOUR, USER, accountSetup, type AccountHarness } from './support/account.js';

interface Outcome {
  state: string;
  fileId: string;
  error?: string | number;
  uploads: number;
  sends: string[];
}
interface Step {
  op: string;
  fileId?: string;
  code?: number;
  expect: Outcome;
}
interface Case {
  name: string;
  rule: string;
  persistence?: boolean;
  start: { kind?: 'image' | 'file'; processing?: boolean; foreignFileId?: string };
  steps: Step[];
}

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/account-session.json', import.meta.url), 'utf8')) as {
  attachmentCases: Case[];
};

const AB = `c2c:${USER}:bob`;
const UPLOADS = '/v1/files/uploads';

let current: AccountHarness | null = null;
afterEach(() => {
  expect(current?.badRequests ?? []).toEqual([]); // 请求体都符合 http-client.schema.json
  current = null;
});

function image(): ProcessedImage {
  return {
    original: { data: new Uint8Array(1000), mime: 'image/jpeg' },
    thumb: { data: new Uint8Array(100), mime: 'image/jpeg' },
    width: 40,
    height: 30,
  };
}

/** 测试用：SDK 内部的消息仓库和源（TS 没有转发入口，造一条带别人 fileId 的消息、删掉源只能这样）。 */
const internals = (h: AccountHarness) =>
  h.im as unknown as {
    store: { list(convId: string): { addLocal(m: Message): void } };
    sources: Map<string, unknown>;
  };

class Runner {
  cid = '';
  private kind: 'image' | 'file' = 'image';
  private resolve: ((p: ProcessedImage) => void) | null = null;

  constructor(
    private h: AccountHarness,
    private c: Case,
  ) {}

  private conn() {
    return this.h.transport.current;
  }

  private allSends() {
    return this.h.transport.connections.flatMap((c) => c.frames().filter((f) => f.cmd === 'send'));
  }

  private message(): Message {
    return this.h.im.messages(AB).find((m) => m.clientMsgId === this.cid)!;
  }

  private async uploadOk(fileId: string): Promise<void> {
    const thumb = this.kind === 'image';
    this.h.http
      .to(UPLOADS)
      .at(-1)!
      .respond(200, {
        fileId,
        put: { url: `https://s3.test/tmp/${fileId}-o`, headers: {}, expiresAt: 1 },
        ...(thumb ? { thumbPut: { url: `https://s3.test/tmp/${fileId}-t`, headers: {}, expiresAt: 1 } } : {}),
      });
    await flush();
    this.h.upload.pending[0]!.respond(200);
    await flush();
    if (thumb) {
      this.h.upload.pending[0]!.respond(200);
      await flush();
    }
    this.h.http.last(`/v1/files/${fileId}/complete`).respond(200, {
      fileId,
      size: 1000,
      mime: thumb ? 'image/jpeg' : 'application/pdf',
      ...(thumb ? { width: 40, height: 30 } : {}),
    });
    await flush();
  }

  async run(st: Step): Promise<Outcome> {
    const uploads0 = this.h.http.to(UPLOADS).length;
    const sends0 = this.allSends().length;
    const s = this.c.start;
    switch (st.op) {
      case 'pick':
        if (s.foreignFileId) {
          this.cid = 'fwd-1';
          internals(this.h)
            .store.list(AB)
            .addLocal({
              clientMsgId: this.cid,
              convId: AB,
              from: USER,
              type: 'image',
              body: { image: { fileId: s.foreignFileId, width: 10, height: 10, size: 100, mime: 'image/jpeg' } },
              ts: 1,
              status: 'failed',
              error: 'timeout',
            });
        } else if (s.kind === 'file') {
          this.kind = 'file';
          this.cid = this.h.im.sendFile(AB, {
            data: new Uint8Array(10),
            name: 'a.pdf',
            mime: 'application/pdf',
          }).clientMsgId;
        } else if (s.processing) {
          this.cid = this.h.im.sendImage(AB, () => new Promise((r) => (this.resolve = r))).clientMsgId;
        } else {
          this.cid = this.h.im.sendImage(AB, image()).clientMsgId;
        }
        await flush();
        break;
      case 'processed':
        this.resolve!(image());
        await flush();
        break;
      case 'uploadOk':
        await this.uploadOk(st.fileId!);
        break;
      case 'uploadFailed':
        this.h.http
          .to(UPLOADS)
          .at(-1)!
          .respond(200, {
            fileId: 'F-FAIL',
            put: { url: 'https://s3.test/tmp/F-FAIL-o', headers: {}, expiresAt: 1 },
            ...(this.kind === 'image'
              ? { thumbPut: { url: 'https://s3.test/tmp/F-FAIL-t', headers: {}, expiresAt: 1 } }
              : {}),
          });
        await flush();
        this.h.upload.pending[0]!.fail();
        await flush();
        break;
      case 'sendAck': {
        const f = this.conn().last('send');
        this.conn().receive({ id: f.id, cmd: 'ack', data: { msgId: 'm1', convId: AB, seq: 1, ts: 9 } });
        await flush();
        break;
      }
      case 'sendError':
        this.conn().ackError('send', st.code!);
        await flush();
        break;
      case 'sendTimeout':
        this.h.clock.advance(10_000);
        await flush();
        break;
      case 'disconnect':
        this.conn().drop(1006);
        await flush();
        break;
      case 'connect':
        this.h.clock.advance(1_000);
        await flush();
        await this.h.login(USER);
        await flush();
        break;
      case 'retry':
        this.h.im.retry(AB, this.cid);
        await flush();
        break;
      case 'dropSource':
        internals(this.h).sources.delete(this.cid);
        break;
      default:
        throw new Error(`unknown op ${st.op}`);
    }
    const m = this.message();
    const sends = this.allSends().slice(sends0);
    for (const f of sends) expect(f.data!['clientMsgId'], 'clientMsgId 始终不变').toBe(this.cid);
    const body = f(m);
    const out: Outcome = {
      state: m.status,
      fileId: body?.fileId ?? '',
      uploads: this.h.http.to(UPLOADS).length - uploads0,
      sends: sends.map((x) => f(x.data as { body: Message['body'] } as Message)?.fileId ?? ''),
    };
    if (m.error !== undefined) out.error = m.error;
    return out;
  }
}

function f(m: { body: Message['body'] }) {
  return m.body.image ?? m.body.file;
}

describe('TC-CHAT-90-13 account-session.json attachmentCases（F-FILE-07 规则 1、3、4）', () => {
  it('用例集覆盖了处理中、待发送、手动重发、4096、自己和别人的 4048、冷启动', () => {
    const ops = new Set(spec.attachmentCases.flatMap((c) => c.steps.map((s) => s.op)));
    for (const op of ['pick', 'processed', 'uploadOk', 'sendError', 'retry', 'dropSource', 'restart'])
      expect(ops).toContain(op);
    expect(spec.attachmentCases.some((c) => c.start.foreignFileId)).toBe(true);
  });

  for (const c of spec.attachmentCases) {
    it.skipIf(c.persistence === true)(`${c.name}（${c.rule}）`, async () => {
      const h = accountSetup();
      current = h;
      h.session(1, 24 * HOUR);
      await h.online();
      const r = new Runner(h, c);
      for (const [i, st] of c.steps.entries()) {
        const got = await r.run(st);
        const want: Partial<Outcome> = { ...st.expect };
        if (want.error === undefined) delete (got as Partial<Outcome>).error; // 没写就不比较
        expect(got, `step ${i} ${st.op}`).toEqual(want);
      }
    });
  }
});
