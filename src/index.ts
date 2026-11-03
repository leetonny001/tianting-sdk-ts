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
export { avatarColorIndex, avatarInitial, fnv1a32 } from './avatar.js';
export {
  CloseCode,
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
  type Platform,
} from './protocol.js';
export type { Clock } from './clock.js';
export type { Logger } from './logger.js';
export { WebSocketTransport, type Transport, type TransportConnection, type TransportHandlers } from './transport.js';
