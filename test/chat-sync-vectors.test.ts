// TC-CHAT-90-13（AC-CHAT-90-15）、TC-FILE-06-11（AC-FILE-06-12）：共享用例 protocol/vectors/chat-sync.json。
// 真实的 IMClient + FakeTransport + 假时钟：connect 真的是重连后的 convs 应答，SDK 发出的每个 sync 都按 convId 回复。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message } from '../src/index.js';
import type { ServerConversation, ServerMessage } from '../src/protocol.js';
import type { FakeConnection } from '../src/testing/index.js';
import { conv, flush, setup, type Harness } from './helpers.js';

interface VMsg {
  seq: number;
  type: 'image' | 'file';
  fileId: string;
  name?: string;
  expired?: boolean;
}
interface VConv {
  convId: string;
  maxSeq: number;
  modVer?: number;
}
interface Step {
  op: 'connect' | 'disconnect' | 'load';
  convs?: VConv[];
  replies?: Record<string, VMsg[]>;
  errors?: Record<string, number>;
  convId?: string;
  messages?: VMsg[];
  expect?: { syncs?: string[]; filesExpired: string[]; messages: Record<string, VMsg[]> };
}

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/chat-sync.json', import.meta.url), 'utf8')) as {
  self: string;
  cases: Array<{ name: string; rule: string; acs: string[]; steps: Step[] }>;
};

/** 按 format 展开成下行消息。 */
function wire(convId: string, m: VMsg): ServerMessage {
  const expired = m.expired ? { expired: true } : {};
  return {
    msgId: `${convId}#${m.seq}`,
    clientMsgId: `bob-${convId}-${m.seq}`,
    convId,
    seq: m.seq,
    from: 'bob',
    type: m.type,
    body:
      m.type === 'image'
        ? { image: { fileId: m.fileId, width: 10, height: 10, size: 100, mime: 'image/png', ...expired } }
        : { file: { fileId: m.fileId, name: m.name ?? '', size: 100, mime: 'application/pdf', ...expired } },
    ts: 1000 + m.seq,
  };
}

function wireConv(c: VConv): ServerConversation {
  return conv({
    convId: c.convId,
    maxSeq: c.maxSeq,
    readSeq: c.maxSeq,
    ...(c.modVer !== undefined ? { modVer: c.modVer } : {}),
  });
}

/** SDK 看到的消息，按用例的写法比较。 */
function view(m: Message): VMsg {
  const f = m.body.image ?? m.body.file;
  const out: VMsg = { seq: m.seq!, type: m.type as VMsg['type'], fileId: f?.fileId ?? '' };
  if (m.type === 'file') out.name = m.body.file?.name ?? '';
  if (f?.expired) out.expired = true;
  return out;
}

class Runner {
  private c: FakeConnection | null = null;
  private answered = new Set<string>();
  private expired: string[] = [];

  constructor(private h: Harness) {
    h.im.on('filesExpired', (ids) => this.expired.push(...ids));
  }

  /** 回复所有还没回的 sync，直到 SDK 不再发。返回这期间发过 sync 的会话。 */
  private async drain(reply: (convId: string) => { messages: VMsg[] } | { code: number }): Promise<string[]> {
    const synced: string[] = [];
    for (let round = 0; round < 50; round++) {
      const open = this.c!.frames().filter((f) => f.cmd === 'sync' && !this.answered.has(f.id!));
      if (open.length === 0) return synced.sort();
      for (const f of open) {
        this.answered.add(f.id!);
        const convId = f.data!['convId'] as string;
        synced.push(convId);
        const r = reply(convId);
        if ('code' in r) this.c!.receive({ id: f.id, cmd: 'ack', error: { code: r.code, msg: 'error' } });
        else
          this.c!.receive({
            id: f.id,
            cmd: 'ack',
            data: { messages: r.messages.map((m) => wire(convId, m)), hasMore: false },
          });
      }
      await flush();
    }
    throw new Error('SDK keeps sending sync');
  }

  async step(st: Step): Promise<string[] | undefined> {
    this.expired = [];
    switch (st.op) {
      case 'connect': {
        if (this.c) {
          this.h.clock.advance(1_000); // 退避后重连
          await flush();
        } else {
          this.h.im.connect('token-value');
        }
        this.c = await this.h.login(spec.self, (st.convs ?? []).map(wireConv));
        return this.drain((id) =>
          st.errors?.[id] !== undefined ? { code: st.errors[id]! } : { messages: st.replies?.[id] ?? [] },
        );
      }
      case 'disconnect':
        this.c!.drop(1006);
        await flush();
        return undefined;
      case 'load':
        void this.h.im.loadHistory(st.convId!);
        await flush();
        await this.drain(() => ({ messages: st.messages ?? [] }));
        return undefined;
    }
  }

  filesExpired(): string[] {
    return [...this.expired].sort();
  }
}

describe('TC-CHAT-90-13 chat-sync.json（F-RCL-03 规则 2、2a：expired 单调合并、modVer 重拉）', () => {
  it('用例集覆盖了 modVer 变化、不变、老服务端、重拉失败、没加载过和迟到的旧应答', () => {
    expect(spec.cases.length).toBeGreaterThanOrEqual(6);
    expect(spec.cases.flatMap((c) => c.steps.map((s) => s.op))).toEqual(
      expect.arrayContaining(['connect', 'disconnect', 'load']),
    );
  });

  for (const c of spec.cases) {
    it(`${c.name}（${c.rule}）`, async () => {
      const h = setup({ timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } });
      const r = new Runner(h);
      for (const [i, st] of c.steps.entries()) {
        const syncs = await r.step(st);
        if (!st.expect) continue;
        const at = `step ${i} ${st.op}`;
        if (st.expect.syncs) expect(syncs, at).toEqual(st.expect.syncs);
        expect(r.filesExpired(), at).toEqual(st.expect.filesExpired);
        for (const [convId, want] of Object.entries(st.expect.messages)) {
          expect(h.im.messages(convId).map(view), `${at} ${convId}`).toEqual(want);
        }
      }
      // 过期的文件名不留在内存里（F-FILE-06 规则 3）：最后一步期望里没有的特征串，导出里也没有。
      const last = c.steps.filter((s) => s.expect).at(-1)!.expect!;
      if (!JSON.stringify(last).includes('ZXQ-FILE-NAME')) {
        expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-FILE-NAME');
      }
    });
  }
});
