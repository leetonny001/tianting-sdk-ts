import { IMClient, type IMClientOptions } from '../src/index.js';
import type { Logger } from '../src/logger.js';
import type { ServerConversation, ServerMessage } from '../src/protocol.js';
import { FakeClock, FakeTransport, type FakeConnection } from '../src/testing/index.js';

/** 让挂起的 Promise 回调执行完（SDK 内部的 await 链）。 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

export interface Harness {
  im: IMClient;
  clock: FakeClock;
  transport: FakeTransport;
  logs: string[];
  visible: { value: boolean };
  /** 打开当前连接并完成 auth；convs 用给定列表回复。 */
  login(userId?: string, convs?: ServerConversation[]): Promise<FakeConnection>;
}

export function setup(opts: Partial<IMClientOptions> = {}): Harness {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  const logs: string[] = [];
  const logger: Logger = {
    debug: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m, e) => logs.push(`${m} ${String(e)}`),
  };
  const visible = { value: true };
  let n = 0;
  const im = new IMClient({
    url: 'ws://im.test/ws',
    transport,
    clock,
    random: () => 0.5, // 抖动为 0，退避间隔精确
    newId: () => `cid-${String(++n).padStart(4, '0')}`,
    logger,
    isVisible: () => visible.value,
    browserEvents: false,
    ...opts,
  });
  const h: Harness = {
    im,
    clock,
    transport,
    logs,
    visible,
    async login(userId = 'alice', convs = []) {
      const c = transport.current;
      c.open();
      c.ack('auth', { userId, serverTime: clock.now() });
      await flush();
      c.ack('convs', { convs, truncated: false });
      await flush();
      return c;
    },
  };
  return h;
}

export function conv(p: Partial<ServerConversation> & { convId: string }): ServerConversation {
  return {
    type: p.convId.startsWith('group:') ? 'group' : 'c2c',
    name: p.convId,
    maxSeq: 0,
    readSeq: 0,
    minSeq: 1,
    unread: 0,
    lastMsg: null,
    updatedAt: 0,
    ...p,
  };
}

export function msg(convId: string, seq: number, from = 'bob', text = `m${seq}`): ServerMessage {
  return {
    msgId: `${convId}#${seq}`,
    clientMsgId: `${from}-${convId}-${seq}`,
    convId,
    seq,
    from,
    type: 'text',
    body: { text },
    ts: 1000 + seq,
  };
}
