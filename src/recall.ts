// 撤回文案和引用摘要（PRD-chat F-RCL-02 规则 1a、F-QUO-02 规则 2、3）。纯函数，页面和 IMClient 共用。
import type { LastMsg, QuoteView } from './protocol.js';
import type { Message } from './store.js';

const QUOTE_LEN = 100;

/**
 * 撤回文案的判断数据（F-RCL-02 规则 1a）。聊天页的提示行和会话列表摘要用同一份（AC-RCL-02-4、03-6、03-10）。
 * operator 是撤回的操作者（recalledBy；老数据没有时按发送者本人撤回），sender 是被撤回的消息的发送者。
 */
export interface RecallNotice {
  convType: 'c2c' | 'group';
  operator: string;
  sender: string;
  /** 操作者是我。 */
  byMe: boolean;
  /** 被撤回的是我的消息。 */
  ofMe: boolean;
  /** 发送者自己撤回（不是群主、管理员撤回别人的）。 */
  own: boolean;
}

/** 从消息或 lastMsg 得到撤回文案的判断数据；不是撤回的（包括后台删除）返回 null。 */
export function recallNoticeOf(
  convId: string,
  m: Pick<Message, 'from' | 'recalled' | 'recalledBy'> | LastMsg,
  me: string,
): RecallNotice | null {
  if (m.recalled !== true) return null;
  const operator = m.recalledBy || m.from;
  return {
    convType: convId.startsWith('group:') ? 'group' : 'c2c',
    operator,
    sender: m.from,
    byMe: operator === me,
    ofMe: m.from === me,
    own: operator === m.from,
  };
}

/**
 * F-RCL-02 规则 1a 的表：
 * 单聊自己撤回：你撤回了一条消息 / 对方撤回了一条消息；群聊自己撤回：你撤回了一条消息 / {操作者}撤回了一条消息；
 * 群主、管理员撤回别人的：你撤回了 {被撤回者} 的一条消息 / {操作者}撤回了你的一条消息 / {操作者}撤回了一条成员消息。
 * nameOf 是各端的显示名规则（问题 19：备注只在本地显示）。
 */
export function recallText(n: RecallNotice, nameOf: (userId: string) => string): string {
  if (n.byMe) return n.own ? '你撤回了一条消息' : `你撤回了 ${nameOf(n.sender)} 的一条消息`;
  if (n.convType === 'c2c') return '对方撤回了一条消息';
  if (n.own) return `${nameOf(n.operator)}撤回了一条消息`;
  if (n.ofMe) return `${nameOf(n.operator)}撤回了你的一条消息`;
  return `${nameOf(n.operator)}撤回了一条成员消息`;
}

/**
 * 引用摘要（F-QUO-02 规则 2，和服务端组装的规则相同）：文本取前 100 个码点（带引用的消息只取它自己的文字，F-QUO-01 规则 4）；
 * 图片"[图片]"；文件"[文件] {文件名}"。
 */
export function quoteSummary(m: Pick<Message, 'type' | 'body'>): string {
  if (m.type === 'image') return '[图片]';
  if (m.type === 'file') return `[文件] ${m.body.file?.name ?? ''}`;
  return Array.from(m.body.text ?? '')
    .slice(0, QUOTE_LEN)
    .join('');
}

/**
 * 引用条显示的文字（F-QUO-02 规则 3）：normal 显示摘要；recalled "引用内容已被撤回"；deleted "引用内容已被删除"；
 * expired "[图片] 已过期" 或 "[文件] 已过期"；不认识的 state "引用内容不可用"。页面按纯文本渲染（AC-QUO-02-5）。
 */
export function quoteLabel(q: QuoteView): string {
  switch (q.state) {
    case 'normal':
      return q.text ?? '';
    case 'recalled':
      return '引用内容已被撤回';
    case 'deleted':
      return '引用内容已被删除';
    case 'expired':
      return `${q.type === 'image' ? '[图片]' : '[文件]'} 已过期`;
  }
  return '引用内容不可用';
}
