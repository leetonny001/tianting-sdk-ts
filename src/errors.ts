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
  constructor(code: number, message: string) {
    super(`${code} ${message}`);
    this.name = 'IMError';
    this.code = code;
  }
  get description(): ErrorDescription {
    return describeError(this.code);
  }
}
