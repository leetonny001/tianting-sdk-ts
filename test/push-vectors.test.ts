// 跑共享行为用例 protocol/vectors/push-sync.json（PRD-live 8.3 节）：走真实的 IMClient + FakeTransport + 假时钟，不改用例。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMClient, type Push } from '../src/index.js';
import { FakeClock, FakeTransport, type FakeConnection } from '../src/testing/index.js';
import type { TimerHandle } from '../src/clock.js';

type Item = Record<string, unknown>;
interface Step {
  op: string;
  id?: string;
  userId?: string;
  serverTime?: number;
  frames?: Item[];
  pushes?: Item[];
  hasMore?: boolean;
  latestSeq?: number;
  code?: number;
  ms?: number;
  unsubscribeOnDeliver?: { pushId: string; id: string };
  expect?: {
    requests?: Item[];
    delivered?: Item[];
    deliveredTo?: Record<string, Item[]>;
    pushSynced?: number[];
    cursor?: number | null;
  };
}
interface Case {
  name: string;
  config?: { persistence?: boolean; pushStart?: 'latest'; stashMax?: number; noSeqQueueMax?: number; seenMax?: number };
  steps: Step[];
}

const file = JSON.parse(readFileSync(new URL('../protocol/vectors/push-sync.json', import.meta.url), 'utf8')) as {
  defaults: { limit: number };
  cases: Case[];
};

/** 比任何用例里推进的总时间都长：请求超时只由 requestTimeout 这一步触发。 */
const REQUEST_TIMEOUT = 9_000_000_000;

/** 假时钟 + 记下请求超时定时器：requestTimeout 只触发 pushSync 的那一个，不推进时间。 */
class RecordingClock extends FakeClock {
  readonly requestTimers: Array<{ fn: () => void; handle: TimerHandle; sentBefore: number }> = [];
  sentCount: () => number = () => 0;

  override setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = super.setTimeout(fn, ms);
    if (ms === REQUEST_TIMEOUT) this.requestTimers.push({ fn, handle, sentBefore: this.sentCount() });
    return handle;
  }
}

function expand(items: Item[] = []): Item[] {
  return items.flatMap((it) => {
    if (!it.seqRange) return [it];
    const [a, b] = it.seqRange as [number, number];
    const { seqRange: _range, idPrefix, ...rest } = it;
    const prefix = (idPrefix as string | undefined) ?? 'p';
    return Array.from({ length: b - a + 1 }, (_, i) => ({ ...rest, pushId: `${prefix}${a + i}`, pushSeq: a + i }));
  });
}

const toFrame = (it: Item) => ({ type: 'notice', data: { text: 'x' }, target: 'user', ...it });

/** 只比对用例写了的字段（format：target、roomId 写了才比）。 */
function view(got: Push[], want: Item[]): Item[] {
  return got.map((p, i) => {
    const out: Item = { pushId: p.pushId };
    for (const k of Object.keys(want[i] ?? { replayed: 0 })) out[k] = (p as unknown as Item)[k];
    return out;
  });
}

async function tick(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

async function run(c: Case): Promise<void> {
  const clock = new RecordingClock();
  const transport = new FakeTransport();
  clock.sentCount = () => transport.current.sent.length;
  const limits = Object.fromEntries(
    (['stashMax', 'noSeqQueueMax', 'seenMax'] as const).flatMap((k) => (c.config?.[k] ? [[k, c.config[k]]] : [])),
  );
  const im = new IMClient({
    url: 'ws://im.test/ws',
    transport,
    clock,
    random: () => 0.5,
    browserEvents: false,
    isVisible: () => true,
    timings: { requestTimeoutMs: REQUEST_TIMEOUT, sendTimeoutMs: REQUEST_TIMEOUT, heartbeatMs: REQUEST_TIMEOUT * 2 },
    pushStart: c.config?.pushStart,
    pushLimits: limits,
  });

  const delivered = new Map<string, Push[]>();
  const unsubs = new Map<string, () => void>();
  let onDeliver: Step['unsubscribeOnDeliver'];
  const synced: number[] = [];
  im.on('pushSynced', (e) => synced.push(e.latestSeq));
  const seenFrames = new Map<FakeConnection, number>();
  let lastReq: { conn: FakeConnection; id: string; index: number } | null = null;

  const newRequests = (): Item[] => {
    const out: Item[] = [];
    for (const conn of transport.connections) {
      const frames = conn.frames();
      for (let i = seenFrames.get(conn) ?? 0; i < frames.length; i++) {
        const f = frames[i]!;
        if (f.cmd !== 'pushSync') continue;
        lastReq = { conn, id: f.id!, index: i };
        out.push(f.data!);
      }
      seenFrames.set(conn, frames.length);
    }
    return out;
  };

  for (const [i, step] of c.steps.entries()) {
    const where = `${c.name} #${i} ${step.op}`;
    const networkOp = ['connect', 'disconnect', 'live', 'ack', 'ackError', 'requestTimeout', 'advance'].includes(
      step.op,
    );
    const before = [...unsubs.keys()];
    if (networkOp) await tick(); // 调度点先于网络事件和定时器；这期间发出的请求算这一步的
    onDeliver = step.unsubscribeOnDeliver;

    // 取"当前" pushSync：调度点可能刚刚发出。
    const stepRequests = newRequests();
    const current = lastReq as { conn: FakeConnection; id: string; index: number } | null;

    switch (step.op) {
      case 'subscribe': {
        const id = step.id!;
        delivered.set(id, delivered.get(id) ?? []);
        unsubs.set(
          id,
          im.on('push', (p) => {
            delivered.get(id)!.push(p);
            if (onDeliver?.pushId === p.pushId && onDeliver.id === id) {
              unsubs.get(id)!();
              unsubs.delete(id);
            }
          }),
        );
        break;
      }
      case 'unsubscribe':
        unsubs.get(step.id!)!();
        unsubs.delete(step.id!);
        break;
      case 'tick':
        break;
      case 'connect': {
        im.connect('token');
        im.networkOnline();
        const conn = transport.current;
        conn.open();
        conn.ack('auth', { userId: step.userId, serverTime: step.serverTime });
        break;
      }
      case 'disconnect':
        transport.current.drop(1006);
        break;
      case 'logout':
        im.disconnect();
        break;
      case 'live':
        for (const f of expand(step.frames)) transport.current.receive({ cmd: 'push', data: toFrame(f) });
        break;
      case 'ack':
        if (current) {
          current.conn.receive({
            id: current.id,
            cmd: 'ack',
            data: { pushes: expand(step.pushes).map(toFrame), hasMore: step.hasMore, latestSeq: step.latestSeq },
          });
        }
        break;
      case 'ackError':
        current?.conn.receive({ id: current.id, cmd: 'ack', error: { code: step.code, msg: 'x' } });
        break;
      case 'requestTimeout': {
        const t = clock.requestTimers.find((r) => r.sentBefore === current!.index);
        expect(t, where).toBeDefined();
        clock.clearTimeout(t!.handle);
        t!.fn();
        break;
      }
      case 'advance':
        clock.advance(step.ms!);
        break;
      default:
        throw new Error(`未知的 op ${step.op}`);
    }
    if (step.op !== 'subscribe') await tick(); // 除 subscribe 外每步结束隐含一次调度点

    const want = step.expect ?? {};
    const requests = [...stepRequests, ...newRequests()];
    const wantRequests = (want.requests ?? []).map((r) => ('afterSeq' in r ? { ...r, limit: file.defaults.limit } : r));
    expect(requests, `${where} requests`).toEqual(wantRequests);
    expect(synced.splice(0), `${where} pushSynced`).toEqual(want.pushSynced ?? []);

    const ids = new Set([...before, ...unsubs.keys()]);
    for (const [id, got] of delivered) {
      const list = got.splice(0);
      const wanted = want.deliveredTo
        ? expand(want.deliveredTo[id])
        : want.delivered && ids.has(id)
          ? expand(want.delivered)
          : [];
      expect(view(list, wanted), `${where} delivered to ${id}`).toEqual(
        wanted.map((w) => {
          const { seqRange: _r, idPrefix: _p, ...rest } = w;
          return rest;
        }),
      );
    }
    if ('cursor' in want) expect(im.pushCursor(), `${where} cursor`).toBe(want.cursor);
  }
}

const runnable = file.cases.filter((c) => !c.config?.persistence);

describe('protocol/vectors/push-sync.json', () => {
  it('sdk-ts 跑全部不要求持久化的用例：71 个里 66 个', () => {
    expect(file.cases).toHaveLength(71);
    expect(runnable).toHaveLength(66);
  });

  it.each(runnable.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await run(c);
  });
});
