// TC-CHAT-90-26（AC-CHAT-90-7）：C4 的新帧喂给 SDK：不崩溃，不认识的字段忽略，撤回的消息按 deleted 清除原文。
// 这个文件只用 C4 之前（f417580）就有的接口和 helpers，同一份文件也拿去跑老版本 sdk-ts@f417580（PRD-chat F-RCL-03 规则 7、
// F-RCL-01 规则 5a：老 SDK 不认识 recalled，但认识 deleted，显示"该消息已被删除"）。不要在这里用 C4 新加的接口。
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '../src/protocol.js';
import { conv, flush, setup } from './helpers.js';

const G = 'group:g1';
const base = (seq: number, from = 'bob') => ({
  msgId: `g1-${seq}`,
  clientMsgId: `${from}-g1-${seq}`,
  convId: G,
  seq,
  from,
  ts: 1000 + seq,
});

describe('TC-CHAT-90-26 C4 新帧和新字段（AC-CHAT-90-7，老版本兼容）', () => {
  it('撤回（msgDeleted 带 recalled、sync 带 deleted+recalled）、quote、mentions、mentionUnread、lastMsg.recalled：不崩溃，内存搜不到原文', async () => {
    const h = setup({ timings: { heartbeatMs: 10 * 365 * 24 * 3_600_000 } });
    h.im.connect('t');
    const convs = (modVer: number, extra: Record<string, unknown> = {}) => [
      {
        ...conv({ convId: G, maxSeq: 5, readSeq: 5, modVer }),
        mentionUnread: 1,
        firstMentionSeq: 4,
        lastMsg: {
          msgId: 'g1-5',
          from: 'bob',
          type: 'text',
          ts: 1005,
          deleted: true,
          recalled: true,
          recalledBy: 'bob',
        },
        ...extra,
      },
    ];
    let c = await h.login('alice', convs(1));
    void h.im.loadHistory(G);
    await flush();
    const messages: ServerMessage[] = [
      { ...base(1), type: 'text', body: { text: 'ZXQ-RCL-2 原文' } },
      { ...base(2), type: 'image', body: { image: { fileId: 'f2', width: 1, height: 1, size: 1, mime: 'image/png' } } },
      { ...base(3), type: 'file', body: { file: { fileId: 'f3', name: 'a.pdf', size: 1, mime: 'application/pdf' } } },
      {
        ...base(4),
        type: 'text',
        body: {
          text: '@alice 看这条',
          quote: { msgId: 'g1-2', seq: 2, from: 'bob', type: 'image', state: 'normal', text: '[图片]' },
          mentions: { userIds: ['alice'], all: false },
        },
      },
      { ...base(5), type: 'text', deleted: true, recalled: true, recalledAt: 2005, recalledBy: 'bob' },
    ];
    c.ack('sync', { messages, hasMore: false });
    await flush();
    // 在线撤回：msgDeleted 带 recalled（老 SDK 不认识这个字段，按删除处理）。
    c.receive({
      cmd: 'event',
      data: { type: 'msgDeleted', convId: G, msgIds: ['g1-1'], seqs: [1], recalled: { by: 'bob', at: 2001 } },
    });
    // 以后的新事件、新字段：忽略。
    c.receive({ cmd: 'event', data: { type: 'convSettingsChanged', convId: G, pinned: true, notifyOff: false } });
    c.receive({
      cmd: 'msg',
      data: { ...base(6), type: 'text', body: { text: '新消息', mentions: { all: true } }, extra: 1 },
    });
    await flush();

    // 离线期间撤回：重连后 sync 带 deleted+recalled。
    c.drop(1006);
    await flush();
    h.clock.advance(1_000);
    await flush();
    c = await h.login('alice', convs(2, { maxSeq: 6 }));
    await flush();
    for (const f of c.frames().filter((x) => x.cmd === 'sync')) {
      c.receive({
        id: f.id,
        cmd: 'ack',
        data: {
          messages: [
            { ...base(1), type: 'text', deleted: true, recalled: true, recalledAt: 2001, recalledBy: 'bob' },
            ...messages.slice(1),
          ],
          hasMore: false,
        },
      });
    }
    await flush();

    const list = h.im.messages(G);
    expect(list.map((x) => [x.seq, x.type, x.deleted === true])).toEqual([
      [1, 'text', true],
      [2, 'image', false],
      [3, 'file', false],
      [4, 'text', false],
      [5, 'text', true],
      [6, 'text', false],
    ]);
    expect(list.find((x) => x.seq === 1)!.body).toEqual({});
    expect(h.im.conversations()[0]!.lastMsg).toMatchObject({ msgId: 'g1-5', deleted: true });
    expect(JSON.stringify(h.im.debugExport())).not.toContain('ZXQ-RCL-2');
  });
});
