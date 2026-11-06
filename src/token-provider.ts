import type { SessionDialog } from './account-policy.js';

/**
 * 连接收到的踢线。reason 为 null 表示没有 kicked 帧，或者 reason 不认识（按关闭码处理）。
 * sid：这条连接用的 token 的 sid，用来认出旧 sid 的踢线（问题 K5）。
 */
export interface KickInfo {
  reason: string | null;
  code: number;
  recoverBefore?: number;
  sid?: string;
}

/** pass：按踢线处理（回登录页）。ignore：这是自己换 sid 造成的，用新 token 重连。 */
export type KickDecision = 'pass' | 'ignore';

/** 会话结束，App 要回登录页。 */
export interface SessionEnd {
  action: 'login' | 'banNotice' | 'logout';
  dialog?: SessionDialog;
  recoverBefore?: number;
  /** 结束的直接原因：4019 的 reason，或踢线原因。 */
  reason?: string;
  code?: number;
  /** kick：来自连接上的踢线，IMClient 的 fatal 已经带了同样的信息。 */
  origin?: 'kick';
}

/** 没有可用的账号会话：没登录，或者已经结束（ended 事件）。end：accessToken() 抛出时带上最近一次结束的原因，没有就是没登录过。 */
export class SessionEndedError extends Error {
  readonly end?: SessionEnd;
  constructor(end?: SessionEnd) {
    super('account session ended');
    this.name = 'SessionEndedError';
    this.end = end;
  }
}

/**
 * IMClient.connect(tokenProvider) 用的 token 来源（PRD-chat 第 13.1 节，F-ACC-03 规则 5、RS5-10：HTTP 和 WS 共用）。
 * AccountClient.tokenProvider 实现了它。保留的 connect(token) 没有这些行为（演示模式）。
 */
export interface TokenProvider {
  /** 拨号前调用。已过期时先刷新再返回；会话结束时用 SessionEndedError reject，连接发 session 类 fatal（问题 K7）。 */
  accessToken(): Promise<string>;
  /** 连接收到 kicked/tokenExpired 或关闭码 4011（规则 7）。resolve 后再 accessToken() 就是可用的；会话结束时 reject。 */
  tokenRejected(token: string): Promise<void>;
  /** 连接被踢（关闭码 4010、4012）。可以先缓存再决定（F-ACC-04 规则 3）。 */
  kickReceived(info: KickInfo): KickDecision | Promise<KickDecision>;
  /** 连接状态：已连接时才用定时器刷新（规则 5）。 */
  connectionChanged(connected: boolean): void;
  /** 回到前台（规则 5）。 */
  foreground(): void;
  /** token 换了：已连接时用 1000 断开，立即用新 token 重连（规则 5）。 */
  onTokenChanged(fn: () => void): () => void;
  onEnded(fn: (e: SessionEnd) => void): () => void;
  /** 账号资料改了（F-ACC-06）：本端立即显示新昵称。 */
  onProfileChanged(fn: (userId: string, nickname: string) => void): () => void;
  /** 服务端说最新一代恢复码没有确认（F-ACC-05 规则 1）。 */
  recoveryCodeUnacked(): void;
}
