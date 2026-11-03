// 由 scripts/gen-errors.mjs 从 protocol/errors.json 生成，不要手改。

/** 错误码。 */
export const ErrorCode = {
  BAD_REQUEST: 4000,
  UNKNOWN_CMD: 4001,
  INVALID_FRAME: 4002,
  MISSING_REQUEST_ID: 4003,
  INVALID_ID: 4004,
  TEXT_EMPTY: 4005,
  TEXT_TOO_LONG: 4006,
  INVALID_CONV_ID: 4007,
  CLIENT_MSG_ID_CONFLICT: 4008,
  INVALID_PLATFORM: 4009,
  TOKEN_INVALID: 4010,
  TOKEN_EXPIRED: 4011,
  TOKEN_REVOKED: 4012,
  ADMIN_KEY_INVALID: 4013,
  ADMIN_SIGNATURE_INVALID: 4017,
  FORBIDDEN: 4030,
  MUTED: 4031,
  NOT_CONV_PARTICIPANT: 4032,
  NOT_GROUP_MEMBER: 4033,
  NOT_FOUND: 4040,
  NOT_IN_ROOM: 4041,
  USER_NOT_FOUND: 4042,
  GROUP_NOT_FOUND: 4043,
  GROUP_EXISTS: 4090,
  GROUP_MEMBER_LIMIT_EXCEEDED: 4130,
  BATCH_LIMIT_EXCEEDED: 4131,
  RATE_LIMITED: 4290,
  INTERNAL: 5000,
  SERVICE_UNAVAILABLE: 5030,
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码的详细信息：是否可以重试、给开发者的说明。 */
export const ERROR_INFO: Readonly<Record<number, { name: string; retryable: boolean; message: string }>> = {
  4000: { name: "BAD_REQUEST", retryable: false, message: "参数不合法" },
  4001: { name: "UNKNOWN_CMD", retryable: false, message: "未知命令" },
  4002: { name: "INVALID_FRAME", retryable: false, message: "帧格式错误" },
  4003: { name: "MISSING_REQUEST_ID", retryable: false, message: "请求缺少 id" },
  4004: { name: "INVALID_ID", retryable: false, message: "ID 格式不合法" },
  4005: { name: "TEXT_EMPTY", retryable: false, message: "消息内容为空" },
  4006: { name: "TEXT_TOO_LONG", retryable: false, message: "消息超过 5000 字" },
  4007: { name: "INVALID_CONV_ID", retryable: false, message: "会话 ID 不合法" },
  4008: { name: "CLIENT_MSG_ID_CONFLICT", retryable: false, message: "clientMsgId 已用于其他会话" },
  4009: { name: "INVALID_PLATFORM", retryable: false, message: "平台标识不合法" },
  4010: { name: "TOKEN_INVALID", retryable: false, message: "登录凭证无效" },
  4011: { name: "TOKEN_EXPIRED", retryable: false, message: "登录凭证已过期" },
  4012: { name: "TOKEN_REVOKED", retryable: false, message: "账号已被强制下线" },
  4013: { name: "ADMIN_KEY_INVALID", retryable: false, message: "管理密钥无效" },
  4017: { name: "ADMIN_SIGNATURE_INVALID", retryable: false, message: "管理接口签名无效" },
  4030: { name: "FORBIDDEN", retryable: false, message: "无权限" },
  4031: { name: "MUTED", retryable: false, message: "已被禁言" },
  4032: { name: "NOT_CONV_PARTICIPANT", retryable: false, message: "不是该会话的参与者" },
  4033: { name: "NOT_GROUP_MEMBER", retryable: false, message: "不是群成员" },
  4040: { name: "NOT_FOUND", retryable: false, message: "资源不存在" },
  4041: { name: "NOT_IN_ROOM", retryable: false, message: "未加入该聊天室" },
  4042: { name: "USER_NOT_FOUND", retryable: false, message: "用户不存在" },
  4043: { name: "GROUP_NOT_FOUND", retryable: false, message: "群不存在" },
  4090: { name: "GROUP_EXISTS", retryable: false, message: "群 ID 已存在" },
  4130: { name: "GROUP_MEMBER_LIMIT_EXCEEDED", retryable: false, message: "群成员超过 2000 人" },
  4131: { name: "BATCH_LIMIT_EXCEEDED", retryable: false, message: "单次批量操作数量超限" },
  4290: { name: "RATE_LIMITED", retryable: true, message: "操作过于频繁" },
  5000: { name: "INTERNAL", retryable: true, message: "服务器内部错误" },
  5030: { name: "SERVICE_UNAVAILABLE", retryable: true, message: "服务暂不可用" },
};

/** WebSocket 关闭码。 */
export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  MESSAGE_TOO_BIG: 1009,
  INVALID_PLATFORM: 4009,
  TOKEN_INVALID: 4010,
  TOKEN_EXPIRED: 4011,
  TOKEN_REVOKED: 4012,
  SLOW_CONSUMER: 4400,
  AUTH_REQUIRED: 4401,
  IDLE_TIMEOUT: 4408,
  TOO_MANY_CONNECTIONS: 4429,
} as const;

/** 关闭后是否应该自动重连（未列出的关闭码按可以重连处理）。 */
export const CLOSE_RECONNECT: Readonly<Record<number, boolean>> = {
  1000: false,
  1001: true,
  1009: true,
  4009: false,
  4010: false,
  4011: false,
  4012: false,
  4400: true,
  4401: true,
  4408: true,
  4429: false,
};

/** 被踢原因 → 关闭码（null 表示保留值，一期不出现）。 */
export const KICK_CLOSE_CODE: Readonly<Record<string, number | null>> = {
  tokenInvalid: 4010,
  tokenExpired: 4011,
  banned: 4012,
  tooManyConnections: 4429,
  serverShutdown: 1001,
  replaced: null,
};
