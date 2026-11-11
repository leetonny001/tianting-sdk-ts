// 举报（PRD-chat F-MOD-03，第 13.1 节，C6）：参数在本地先校验，不合法直接抛 4000，不发帧。
import { ErrorCode, IMError } from './errors.js';
import { ConvIdError, isValidId, parseConvIdStrict, REPORT_REASONS, type ReportReq } from './protocol.js';
import { countCodePoints } from './text.js';

/** note 最多 200 个码点（和服务端一样按码点数，frontend-chat 第 84 条）。 */
export const REPORT_NOTE_MAX = 200;
/** 一次最多举报 20 条消息（协议上限；第一批页面只举报单条，第 85 条）。 */
export const REPORT_MSG_MAX = 20;

/** report() 的参数：字段和 report 命令相同（msgIds 可以是只读数组）。 */
export type ReportInput = Omit<ReportReq, 'msgIds'> & { msgIds?: readonly string[] };

const FIELDS = new Set(['targetType', 'convId', 'msgIds', 'userId', 'groupId', 'reason', 'note']);

/** 本地校验不通过：4000，details.field 指出是哪个字段。错误信息里不带 note 和其他参数的值。 */
function bad(field: string): IMError {
  return new IMError(ErrorCode.BAD_REQUEST, `invalid report ${field}`, undefined, { field });
}

/**
 * 校验并组装 report 命令的 data。不认识的字段、按 targetType 互斥的字段（带了别的对象的）都是 4000。
 * self 还不知道时（没连上过）只校验格式，参与者由服务端判断。
 */
export function reportRequest(input: ReportInput, self: string | null): ReportReq {
  if (typeof input !== 'object' || input === null) throw bad('input');
  for (const k of Object.keys(input)) if (!FIELDS.has(k)) throw bad(k); // 和 Schema 一样不允许多余字段
  const { targetType, convId, msgIds, userId, groupId, reason, note } = input;
  if (!REPORT_REASONS.includes(reason)) throw bad('reason');
  if (note !== undefined && (typeof note !== 'string' || countCodePoints(note) > REPORT_NOTE_MAX)) throw bad('note');
  const has = (v: unknown) => v !== undefined;
  const out: ReportReq = { targetType, reason };
  switch (targetType) {
    case 'message': {
      if (has(userId) || has(groupId)) throw bad('targetType');
      if (typeof convId !== 'string') throw bad('convId');
      try {
        parseConvIdStrict(convId, self ?? convId.split(':')[1] ?? '');
      } catch (e) {
        if (e instanceof ConvIdError) throw bad('convId');
        throw e;
      }
      if (!Array.isArray(msgIds) || msgIds.length < 1 || msgIds.length > REPORT_MSG_MAX) throw bad('msgIds');
      if (!msgIds.every(isValidId)) throw bad('msgIds');
      out.convId = convId;
      out.msgIds = [...msgIds];
      break;
    }
    case 'user':
      if (has(convId) || has(msgIds) || has(groupId)) throw bad('targetType');
      if (!isValidId(userId)) throw bad('userId');
      out.userId = userId;
      break;
    case 'group':
      if (has(convId) || has(msgIds) || has(userId)) throw bad('targetType');
      if (!isValidId(groupId)) throw bad('groupId');
      out.groupId = groupId;
      break;
    default:
      throw bad('targetType');
  }
  if (note !== undefined) out.note = note;
  return out;
}
