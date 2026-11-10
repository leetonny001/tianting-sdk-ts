// TC-CHAT-90-13（AC-CHAT-90-15）、TC-FILE-06-11（AC-FILE-06-12）：共享用例 protocol/vectors/chat-sync.json。
// C4（FE-660）：TC-RCL-03-13（AC-RCL-03-13）、TC-QUO-02-02（AC-QUO-02-2）、TC-QUO-02-06（AC-QUO-02-6）、TC-MEN-03-07（AC-MEN-03-7）
// 的同名用例也在这里跑：步骤 event、advance，期望 convsFetches、mentionUnread。
// C5（FE-680，BE-487）：TC-CHAT-90-39（AC-CHAT-90-15）：置顶排序、deleted 判断、本地清除、convDeleted 之后的状态、总未读；
// connect 带 truncated、deleted、deletedTruncated，期望 conversations、convState、removed、totalUnread。
// 真实的 IMClient + FakeTransport + 假时钟：connect 真的是重连后的 convs 应答，SDK 发出的每个 sync 都按 convId 回复。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Conversation, Message } from '../src/index.js';
import type { MsgBody, ServerConversation, ServerMessage } from '../src/protocol.js';
import type { FakeConnection } from '../src/testing/index.js';
import { conv, flush, setup, type Harness } from './helpers.js';

interface VQuote {
  seq: number;
  state: string;
  text?: string;
}
interface VMsg {
  seq: number;
  type: 'image' | 'file' | 'text';
  fileId?: string;
  name?: string;
  expired?: boolean;
  text?: string;
  quote?: VQuote;
  deleted?: boolean;
  recalled?: boolean;
  recalledBy?: string;
}
interface VConv {
  convId: string;
  maxSeq: number;
  modVer?: number;
  mentionUnread?: number;
  minSeq?: number;
  unread?: number;
  updatedAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  notifyOff?: boolean;
}
interface VConvState {
  minSeq: number;
  unread: number;
  pinned?: boolean;
  pinnedAt?: number;
  notifyOff?: boolean;
}
interface Step {
  op: 'connect' | 'disconnect' | 'load' | 'event' | 'advance';
  convs?: VConv[];
  replies?: Record<string, VMsg[]>;
  errors?: Record<string, number>;
  convId?: string;
  messages?: VMsg[];
  event?: Record<string, unknown>;
  ms?: number;
  truncated?: boolean;
  deleted?: Array<{ convId: string; clearedSeq: number }>;
  deletedTruncated?: boolean;
  expect?: {
    syncs?: string[];
    filesExpired: string[];
    messages: Record<string, VMsg[]>;
    convsFetches?: number;
    mentionUnread?: Record<string, number>;
    conversations?: string[];
    convState?: Record<string, VConvState>;
    removed?: string[];
    totalUnread?: number;
  };
}

const spec = JSON.parse(readFileSync(new URL('../protocol/vectors/chat-sync.json', import.meta.url), 'utf8')) as {
  self: string;
  cases: Array<{ name: string; rule: string; acs: string[]; steps: Step[] }>;
};

/** 按 format 展开成下行消息。 */
function wire(convId: string, m: VMsg): ServerMessage {
  const base = {
    msgId: `${convId}#${m.seq}`,
    clientMsgId: `bob-${convId}-${m.seq}`,
    convId,
    seq: m.seq,
    from: 'bob',
    type: m.type,
    ts: 1000 + m.seq,
  };
  if (m.deleted) {
    return {
      ...base,
      deleted: true,
      ...(m.recalled ? { recalled: true, recalledAt: 2000 + m.seq, recalledBy: m.recalledBy! } : {}),
    };
  }
  const expired = m.expired ? { expired: true } : {};
  const body: MsgBody =
    m.type === 'image'
      ? { image: { fileId: m.fileId!, width: 10, height: 10, size: 100, mime: 'image/png', ...expired } }
      : m.type === 'file'
        ? { file: { fileId: m.fileId!, name: m.name ?? '', size: 100, mime: 'application/pdf', ...expired } }
        : { text: m.text! };
  if (m.quote) {
    body.quote = {
      msgId: `${convId}#${m.quote.seq}`,
      seq: m.quote.seq,
      from: 'bob',
      type: 'text',
      state: m.quote.state,
      ...(m.quote.text !== undefined ? { text: m.quote.text } : {}),
    };
  }
  return { ...base, body };
}

/** 会话的写法（format 的"会话"）：C5 的 unread 不为 0 时 readSeq = maxSeq − unread，和服务端的算法一致。 */
function wireConv(c: VConv): ServerConversation {
  return conv({
    convId: c.convId,
    maxSeq: c.maxSeq,
    readSeq: c.maxSeq - (c.unread ?? 0),
    minSeq: c.minSeq ?? 1,
    unread: c.unread ?? 0,
    updatedAt: c.updatedAt ?? 0,
    ...(c.pinned ? { pinned: true, pinnedAt: c.pinnedAt! } : {}),
    ...(c.notifyOff ? { notifyOff: true } : {}),
    ...(c.modVer !== undefined ? { modVer: c.modVer } : {}),
    ...(c.mentionUnread !== undefined ? { mentionUnread: c.mentionUnread } : {}),
    ...(c.mentionUnread ? { firstMentionSeq: c.maxSeq } : {}),
  });
}

/** SDK 看到的消息，按用例的写法比较。删除的消息只比较 seq、type、deleted、recalled、recalledBy，正文必须已清空。 */
function view(m: Message): VMsg {
  const out: VMsg = { seq: m.seq!, type: m.type as VMsg['type'] };
  if (m.deleted) {
    expect(m.body, `seq ${m.seq} body`).toEqual({});
    out.deleted = true;
    if (m.recalled) out.recalled = true;
    if (m.recalledBy) out.recalledBy = m.recalledBy;
    return out;
  }
  const f = m.body.image ?? m.body.file;
  if (m.type === 'image' || m.type === 'file') out.fileId = f?.fileId ?? '';
  if (m.type === 'file') out.name = m.body.file?.name ?? '';
  if (f?.expired) out.expired = true;
  if (m.body.text !== undefined) out.text = m.body.text;
  const q = m.body.quote;
  if (q) out.quote = { seq: q.seq!, state: q.state, ...(q.text !== undefined ? { text: q.text } : {}) };
  return out;
}

/** 用例名带 TC 编号：C4 的用例是 TC-CHAT-90-33 加各自的 TC（docs/testcases），C2 的是 TC-CHAT-90-13。 */
const TC: Readonly<Record<string, string>> = {
  'AC-FILE-06-12': 'TC-FILE-06-11',
  'AC-RCL-03-11': 'TC-RCL-03-11',
  'AC-RCL-03-13': 'TC-RCL-03-13',
  'AC-QUO-02-2': 'TC-QUO-02-02',
  'AC-QUO-02-6': 'TC-QUO-02-06',
  'AC-MEN-03-7': 'TC-MEN-03-07',
};
/** AC-CVS-03-5 → TC-CVS-03-05（docs/testcases/TC-CVS.md 按 AC 编号对齐）。 */
const cvsTc = (a: string) =>
  a.replace(/^AC-CVS-(\d\d)-(\d+)$/, (_, x: string, y: string) => `TC-CVS-${x}-${y.padStart(2, '0')}`);
function tcOf(acs: string[]): string {
  const c5 = acs.some((a) => a.startsWith('AC-CVS-'));
  const c4 = acs.some((a) => /^AC-(QUO|MEN)-|^AC-RCL-03-13$/.test(a));
  const head = c5 ? 'TC-CHAT-90-39' : c4 ? 'TC-CHAT-90-33' : 'TC-CHAT-90-13';
  return [head, ...acs.map((a) => TC[a] ?? cvsTc(a))].join(' ');
}

/** SDK 列表里每个会话和用例有关的状态（convState）。 */
function convState(x: Conversation): VConvState {
  const out: VConvState = { minSeq: x.minSeq, unread: x.unread };
  if (x.pinned) out.pinned = true;
  if (x.pinnedAt !== undefined) out.pinnedAt = x.pinnedAt;
  if (x.notifyOff) out.notifyOff = true;
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

  /** 回复这一步里 SDK 为提及计数发出的 convs（F-MEN-03 规则 1）。返回这一步发了几次。 */
  private async answerConvs(st: Step): Promise<number> {
    let n = 0;
    for (let round = 0; round < 10; round++) {
      const open = this.c!.frames().filter((f) => f.cmd === 'convs' && !this.answered.has(f.id!));
      if (open.length === 0) return n;
      for (const f of open) {
        this.answered.add(f.id!);
        n++;
        if (!st.convs) throw new Error(`step ${st.op} has no convs reply but the SDK fetched convs`);
        this.c!.receive({ id: f.id, cmd: 'ack', data: { convs: st.convs.map(wireConv), truncated: false } });
      }
      await flush();
    }
    throw new Error('SDK keeps sending convs');
  }

  /** 这一步里 SDK 发过的 convs 次数（event、advance）。 */
  fetches = 0;
  /** 用例里出现过的会话（removed 在这些里面找快照）。 */
  seen = new Set<string>();

  async step(st: Step): Promise<string[] | undefined> {
    this.expired = [];
    this.fetches = 0;
    switch (st.op) {
      case 'connect': {
        if (this.c) {
          this.h.clock.advance(1_000); // 退避后重连
          await flush();
        } else {
          this.h.im.connect('token-value');
        }
        this.c = this.h.transport.current;
        this.c.open();
        this.c.ack('auth', { userId: spec.self, serverTime: this.h.clock.now() });
        await flush();
        for (const c of st.convs ?? []) this.seen.add(c.convId);
        for (const d of st.deleted ?? []) this.seen.add(d.convId);
        this.c.ack('convs', {
          convs: (st.convs ?? []).map(wireConv),
          truncated: st.truncated === true,
          ...(st.deleted ? { deleted: st.deleted } : {}),
          ...(st.deletedTruncated ? { deletedTruncated: true } : {}),
        });
        await flush();
        for (const f of this.c.frames()) if (f.cmd === 'convs') this.answered.add(f.id!);
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
      case 'event':
        this.c!.receive({ cmd: 'event', data: st.event });
        if (typeof st.event?.['convId'] === 'string') this.seen.add(st.event['convId']);
        await flush();
        this.fetches = await this.answerConvs(st);
        return this.drain(() => ({ messages: [] }));
      case 'advance':
        this.h.clock.advance(st.ms!);
        await flush();
        this.fetches = await this.answerConvs(st);
        return this.drain(() => ({ messages: [] }));
    }
  }

  filesExpired(): string[] {
    return [...this.expired].sort();
  }
}

describe('TC-CHAT-90-13 chat-sync.json（F-RCL-03 规则 2、2a：单调合并、modVer 重拉；F-QUO-02 规则 4；F-MEN-03 规则 1）', () => {
  it('用例集覆盖了 modVer 变化、不变、老服务端、重拉失败、没加载过和迟到的旧应答', () => {
    expect(spec.cases.length).toBeGreaterThanOrEqual(6);
    expect(spec.cases.flatMap((c) => c.steps.map((s) => s.op))).toEqual(
      expect.arrayContaining(['connect', 'disconnect', 'load']),
    );
  });

  it('C4 的用例都在（BE-478）：撤回合并、引用清除、提及计数，用到 event 和 advance', () => {
    const acs = spec.cases.flatMap((c) => c.acs);
    for (const ac of ['AC-RCL-03-13', 'AC-QUO-02-2', 'AC-QUO-02-6', 'AC-MEN-03-7']) expect(acs).toContain(ac);
    const c4 = spec.cases.filter((c) => !c.acs.some((a) => a.startsWith('AC-CVS-')));
    expect(c4.filter((c) => c.steps.some((s) => s.op === 'event' || s.op === 'advance')).length).toBe(4);
    expect(spec.cases.filter((c) => !c.acs.some((a) => a.startsWith('AC-CVS-'))).length).toBe(13); // C2 7 个 + C4 6 个
  });

  it('C5 的用例都在（BE-487）：置顶排序、deleted 判断、truncated / deletedTruncated、本地清除、convDeleted、总未读', () => {
    const c5 = spec.cases.filter((c) => c.acs.some((a) => a.startsWith('AC-CVS-')));
    expect(c5).toHaveLength(6);
    const acs = c5.flatMap((c) => c.acs);
    for (const ac of ['AC-CVS-01-1', 'AC-CVS-03-5', 'AC-CVS-03-2', 'AC-CVS-04-5', 'AC-CVS-02-5', 'AC-CVS-04-1']) {
      expect(acs).toContain(ac);
    }
    const steps = c5.flatMap((c) => c.steps);
    expect(steps.some((s) => s.deletedTruncated)).toBe(true);
    expect(steps.some((s) => s.truncated)).toBe(true);
    expect(steps.some((s) => s.event?.['type'] === 'convDeleted')).toBe(true);
    expect(steps.some((s) => s.event?.['type'] === 'convSettingsChanged')).toBe(true);
    expect(steps.filter((s) => s.expect?.conversations).length).toBeGreaterThan(0);
  });

  for (const c of spec.cases) {
    it(`${tcOf(c.acs)} ${c.name}（${c.rule}）`, async () => {
      const h = setup({ timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } });
      const r = new Runner(h);
      for (const [i, st] of c.steps.entries()) {
        const syncs = await r.step(st);
        if (!st.expect) continue;
        const at = `step ${i} ${st.op}`;
        if (st.expect.syncs) expect(syncs, at).toEqual(st.expect.syncs);
        else if (st.op === 'event' || st.op === 'advance') expect(syncs, `${at} syncs`).toEqual([]);
        expect(r.filesExpired(), at).toEqual(st.expect.filesExpired);
        for (const [convId, want] of Object.entries(st.expect.messages)) {
          expect(h.im.messages(convId).map(view), `${at} ${convId}`).toEqual(want);
        }
        if (st.expect.convsFetches !== undefined) expect(r.fetches, `${at} convsFetches`).toBe(st.expect.convsFetches);
        if (st.expect.mentionUnread) {
          const got = Object.fromEntries(
            h.im
              .conversations()
              .filter((x) => x.mentionUnread !== undefined)
              .map((x) => [x.convId, x.mentionUnread]),
          );
          expect(got, `${at} mentionUnread`).toEqual(st.expect.mentionUnread);
        }
        if (st.expect.conversations) {
          expect(
            h.im.conversations().map((x) => x.convId),
            `${at} conversations`,
          ).toEqual(st.expect.conversations);
        }
        if (st.expect.convState) {
          const got = Object.fromEntries(h.im.conversations().map((x) => [x.convId, convState(x)]));
          expect(got, `${at} convState`).toEqual(st.expect.convState);
        }
        if (st.expect.removed) {
          const got = [...r.seen].filter((id) => h.im.conversationSnapshot(id)).sort();
          expect(got, `${at} removed`).toEqual(st.expect.removed);
        }
        if (st.expect.totalUnread !== undefined) {
          expect(h.im.totalUnread(), `${at} totalUnread`).toBe(st.expect.totalUnread);
        }
      }
      // 过期的文件名、撤回的原文、引用的原文不留在内存里（F-FILE-06 规则 3、F-RCL-03 规则 3、F-QUO-02 规则 4）：
      // 最后一步期望里没有的特征串，导出里也没有。
      const last = JSON.stringify(c.steps.filter((s) => s.expect).at(-1)!.expect!);
      const dump = JSON.stringify(h.im.debugExport());
      for (const mark of ['ZXQ-FILE-NAME', 'ZXQ-RCL-2', 'ZXQ-QUO-1', 'ZXQ-CVS-1']) {
        if (!last.includes(mark)) expect(dump, mark).not.toContain(mark);
      }
    });
  }
});
