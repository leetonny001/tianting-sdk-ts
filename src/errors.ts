import { ERROR_INFO } from './errors.gen.js';

export { ErrorCode, CloseCode, CLOSE_RECONNECT, KICK_CLOSE_CODE } from './errors.gen.js';

/** 错误码的分类，界面据此决定文案（PRD F-SYS-01、C-09）。 */
export type ErrorCategory = 'badRequest' | 'forbidden' | 'notFound' | 'rateLimited' | 'server';

export interface ErrorDescription {
  code: number;
  /** errors.json 里的名称；不认识的错误码为 "UNKNOWN"。 */
  name: string;
  category: ErrorCategory;
  retryable: boolean;
}

/**
 * 描述一个错误码。不认识的错误码按前三位区段兜底（C-09）：
 * 403x 无权限、404x 不存在、429x 太频繁、其他 4xxx 请求出错（都不重试）；5xxx 服务端错误（可以重试）。
 */
export function describeError(code: number): ErrorDescription {
  const known = ERROR_INFO[code];
  return {
    code,
    name: known?.name ?? 'UNKNOWN',
    category: categorize(code),
    retryable: known ? known.retryable : code >= 5000,
  };
}

function categorize(code: number): ErrorCategory {
  const prefix = Math.floor(code / 10);
  if (prefix === 403) return 'forbidden';
  if (prefix === 404) return 'notFound';
  if (prefix === 429) return 'rateLimited';
  return code >= 5000 ? 'server' : 'badRequest';
}

/** 服务端返回的错误（ack.error）。 */
export class IMError extends Error {
  readonly code: number;
  /** 建群失败时是哪个人（error.userId，兼容 details.userId，PRD-core D-1 未定）。 */
  readonly userId?: string;
  /** error.details 原样透传，例如 4031 的 {scope, groupId?, mutedUntil}。 */
  readonly details?: Readonly<Record<string, unknown>>;
  constructor(code: number, message: string, userId?: string, details?: Readonly<Record<string, unknown>>) {
    super(`${code} ${message}`);
    this.name = 'IMError';
    this.code = code;
    this.userId = userId;
    this.details = details;
  }
  get description(): ErrorDescription {
    return describeError(this.code);
  }
}

/**
 * "命令 + 错误码"文案（PRD-social 9.4 节、ERRORS.md 第 2 节；用例 protocol/vectors/social.json 的 copy）。
 * 这里只列与命令相关的码；没有列出的返回 undefined，界面用该码的默认文案。
 * strangerMsgLimit 填进 4137 的 N（取最近一次同步 / 事件中的值）；name 填进建群 / 邀请失败的 {name}。
 */
export function messageFor(
  cmd: string,
  code: number,
  ctx: { strangerMsgLimit?: number; name?: string } = {},
): string | undefined {
  const t = COPY[`${cmd}:${code}`] ?? COPY[`*:${code}`];
  return t?.replace('{N}', String(ctx.strangerMsgLimit ?? 0)).replace('{name}', ctx.name ?? '');
}

const DAILY = '今天的次数已用完，明天再试';
const COPY: Readonly<Record<string, string>> = {
  'send:4290': '发送太频繁，请稍后再试',
  '*:4290': '操作太频繁，请稍后再试',
  'send:4035': '对方开启了好友验证，你还不是他的好友',
  'send:4036': '消息已发出，但被对方拒收了',
  'send:4137': '对方回复之前，最多只能发送 {N} 条消息',
  'send:4292': '今天发起新聊天的次数已用完，请稍后再试',
  'friendApply:4132': '你的好友数量已达上限',
  'friendRespond:4132': '你的好友数量已达上限',
  'friendRespond:4133': '对方好友数量已达上限',
  'friendApply:4133': '对方好友数量已达上限',
  'friendRespond:4045': '该申请已过期',
  'block:4134': '黑名单已满',
  'friendApply:4292': DAILY,
  'userSearch:4292': DAILY,
  'block:4292': DAILY,
  'unblock:4292': DAILY,
  'groupCreate:4035': '{name} 不是你的好友，无法邀请',
  'groupInvite:4035': '{name} 不是你的好友，无法邀请',
  'groupCreate:4135': '{name} 加入的群聊已达上限',
  'groupInvite:4135': '{name} 加入的群聊已达上限',
  'groupCreate:4030': '当前不允许创建群聊',
  'groupCreate:4292': DAILY,
  'groupTransfer:4046': '对方已不在群里',
  'groupSetAdmin:4046': '对方已不在群里',
  'groupSetAdmin:4136': '管理员最多 10 人',
};
