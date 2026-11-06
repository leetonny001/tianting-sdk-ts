// 账号会话的判断（PRD-chat F-ACC-03 规则 5、6、6a、7）：纯函数，不碰网络、存储和定时器。
// 和 server/e2e/accountmodel/model.go 逐条对应，协议用例 protocol/vectors/account-session.json 约束它；Kotlin、Swift 照这里写。
// 语义说明见 docs/sdk/README.md 第 6 节。

import { KICK_CLOSE_CODE } from './errors.js';

/** 不足这么久就刷新（IM_ACCESS_TTL 的 1/4，规则 5）。剩余恰好 6 小时不刷新。 */
export const REFRESH_BELOW_MS = 6 * 3600 * 1000;
/** 连续收到这么多次 superseded 就回登录页（规则 6）。 */
export const MAX_SUPERSEDED = 3;
/** 刷新、改密等请求的超时（规则 5，RS5-15）。 */
export const ACCOUNT_REQUEST_TIMEOUT_MS = 30_000;

/** 回登录页时的提示（规则 6、6a）。名字和 model.go 相同。 */
export type SessionDialog =
  | 'sessionExpired' // "登录已失效，请重新登录"
  | 'credentialAnomaly' // "检测到登录凭证异常…"
  | 'recoverBefore' // "如果不是你本人操作，请在 {日期} 前用恢复码找回"
  | 'supersededExceeded' // superseded 重试用完
  | 'accountOffline' // kicked 没有日期时按关闭码 4012 的文案
  | 'recoveryCodeStale'; // "恢复码已更新，请重新登录查看"

/** 一步判断的结果。action 的取值和 model.go 相同。 */
export type SessionOutcome =
  | { action: 'none' | 'useLocal' | 'backoff' | 'keepToken' | 'banNotice' }
  | { action: 'refresh'; attempt: number }
  | { action: 'retryAfter'; retryAfterSeconds?: number }
  | { action: 'login'; dialog?: SessionDialog; recoverBefore?: number };

export type RefreshSource = 'start' | 'foreground' | 'timer' | 'kicked';

/** 刷新失败。code 为 0 表示没有拿到服务端的错误码：网络错误、超时，或者响应不是约定的 JSON。 */
export interface RefreshFailure {
  code: number;
  reason?: string;
  retryAfterSeconds?: number;
  recoverBefore?: number;
}

/** token 的身份。sid 不同就是不同的链，代号不能互相比较（改密、退出其他设备后 gen 从头开始）。 */
export interface TokenLineage {
  sid: string;
  gen: number;
}

/** 从 JWT 取 sid 和 gen，只用来比较，不验签。解析不了按 {sid:'', gen:0}：最不新，走刷新这条安全的路。 */
export function lineageOf(token: string): TokenLineage {
  try {
    const payload = token.split('.')[1] ?? '';
    const text = new TextDecoder().decode(fromBase64Url(payload));
    const c = JSON.parse(text) as { sid?: unknown; gen?: unknown };
    return { sid: typeof c.sid === 'string' ? c.sid : '', gen: typeof c.gen === 'number' ? c.gen : 0 };
  } catch {
    return { sid: '', gen: 0 };
  }
}

function fromBase64Url(s: string): Uint8Array {
  const bin = atob(
    s
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(s.length / 4) * 4, '='),
  );
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/** 规则 7：本地 token 比被拒绝的新吗。换过 sid 一定更新：SDK 只会从旧 sid 换到新 sid。 */
export function isLocalNewer(local: TokenLineage, rejected: Partial<TokenLineage>): boolean {
  if (rejected.sid !== undefined && rejected.sid !== local.sid) return true;
  return local.gen > (rejected.gen ?? 0);
}

/** 规则 5 和 RS5-11：现在该主动刷新吗。 */
export function shouldRefresh(accessExpiresAt: number, absoluteExpiresAt: number | undefined, now: number): boolean {
  if (accessExpiresAt === absoluteExpiresAt) return false;
  return accessExpiresAt - now < REFRESH_BELOW_MS;
}

/**
 * 规则 6、6a：刷新失败怎么办。superseded 是这次之前已经连续收到的次数。
 * 和 model.go 的 RefreshFailed 一致：code 0、4290、5xx 留在当前页面退避；没有列出的码回登录页。
 */
export function classifyRefreshFailure(f: RefreshFailure, superseded: number): SessionOutcome {
  if (f.code === 0 || f.code === 4290 || f.code >= 5000) return { action: 'backoff' };
  if (f.code === 4034) return { action: 'banNotice' };
  if (f.code === 4019) {
    if (f.reason === 'superseded') {
      if (superseded + 1 >= MAX_SUPERSEDED) return { action: 'login', dialog: 'supersededExceeded' };
      return { action: 'retryAfter', ...positive('retryAfterSeconds', f.retryAfterSeconds) };
    }
    if (f.reason === 'replayDetected') {
      return { action: 'login', dialog: 'credentialAnomaly', ...positive('recoverBefore', f.recoverBefore) };
    }
    return loginWithDate('sessionExpired', f.recoverBefore);
  }
  return { action: 'login', dialog: 'sessionExpired' };
}

/** kicked 时回登录页的提示：有日期统一提示日期（规则 6a）。 */
export function kickOutcome(reason: string | null, recoverBefore: number | undefined): SessionOutcome {
  if (reason === 'tokenInvalid' || reason === 'tokenExpired') return { action: 'login', dialog: 'sessionExpired' };
  return loginWithDate('accountOffline', recoverBefore);
}

function loginWithDate(dialog: SessionDialog, recoverBefore: number | undefined): SessionOutcome {
  if (recoverBefore && recoverBefore > 0) return { action: 'login', dialog: 'recoverBefore', recoverBefore };
  return { action: 'login', dialog };
}

function positive<K extends string>(key: K, v: number | undefined): Partial<Record<K, number>> {
  return v && v > 0 ? ({ [key]: v } as Record<K, number>) : {};
}

/** 这个踢线说明设备会话已经不能用了（关闭码 4010、4012）：本地 token 要清除。 */
export function kickEndsSession(reason: string | null, code: number): boolean {
  if (reason === null) return code === 4010 || code === 4012;
  const c = KICK_CLOSE_CODE[reason];
  return c === 4010 || c === 4012;
}

/** 改密、退出其他设备、注销进行中要缓存的踢线（F-ACC-04 规则 3）。封禁等其他原因不等。不认识的原因看关闭码。 */
export function kickIsHoldable(reason: string | null, code: number): boolean {
  if (reason === 'passwordChanged' || reason === 'sessionRevoked' || reason === 'accountDeleted') return true;
  return reason === null && code === 4012;
}

/** PRD 规定的提示文字（规则 6、6a，F-ACC-05 规则 1）。三端显示同一句，放在 SDK。formatDate 由 App 决定时区和格式。 */
export function sessionDialogText(
  e: { dialog?: SessionDialog; recoverBefore?: number },
  formatDate: (ms: number) => string = (ms) => new Date(ms).toLocaleDateString('zh-CN'),
): string | undefined {
  switch (e.dialog) {
    case 'credentialAnomaly':
      return '检测到登录凭证异常，这台设备已下线。如果不是你本人操作，请尽快改密码';
    case 'recoverBefore':
      return `你的账号凭证有变化。如果不是你本人操作，请在 ${formatDate(e.recoverBefore ?? 0)} 前用恢复码找回`;
    case 'sessionExpired':
    case 'supersededExceeded':
      return '登录已失效，请重新登录';
    case 'accountOffline':
      return '账号已被下线';
    case 'recoveryCodeStale':
      return '恢复码已更新，请重新登录查看';
    default:
      return undefined;
  }
}
