// IM 统一 SDK（TypeScript）。对外接口见 docs/sdk/README.md。
export {
  IMClient,
  type ApplyFriendOptions,
  type IMClientOptions,
  type IMClientTimings,
  type SendResult,
} from './client.js';
export {
  REQUEST_RETENTION_MS,
  SocialState,
  tipText,
  type GroupInfo,
  type GroupMemberInfo,
  type ApplySource,
  type BlockItem,
  type BlockedUser,
  type Friend,
  type FriendItem,
  type FriendRequest,
  type MyGroup,
  type Profile,
  type Relation,
  type RequestItem,
  type RequestStatus,
  type SearchedUser,
  type SocialSettings,
  type SocialSyncAck,
  type UserProfile,
} from './social.js';
export type { ConnState, FatalReason } from './connection.js';
export { ConnectionClosedError, NotConnectedError, TimeoutError } from './connection.js';
export type { Conversation, ConversationSnapshot, Message, MessageStatus } from './store.js';
export type { MuteInfo } from './mute.js';
export { PUSH_DEFAULTS, type Push, type PushLimits, type PushStart } from './push.js';
export { avatarColorIndex, avatarInitial, fnv1a32 } from './avatar.js';
export { FetchHttpTransport, type HttpRequest, type HttpResponse, type HttpTransport } from './http.js';
export {
  CLIENT_ERROR_CODES,
  CloseCode,
  ERROR_REASONS,
  ErrorCode,
  IMError,
  describeError,
  messageFor,
  type ErrorCategory,
  type ErrorDescription,
} from './errors.js';
export { MAX_TEXT_LENGTH, checkText, countCodePoints, trimText, type TextCheck } from './text.js';
export {
  ConvIdError,
  c2cConvId,
  groupConvId,
  parseConvIdStrict,
  peerId,
  type ConvType,
  type GroupRole,
  type TipBody,
  type Platform,
} from './protocol.js';
export type { Clock } from './clock.js';
export type { Logger } from './logger.js';
export { WebSocketTransport, type Transport, type TransportConnection, type TransportHandlers } from './transport.js';
