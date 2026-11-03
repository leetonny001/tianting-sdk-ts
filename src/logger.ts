/** 日志接口。SDK 不直接用 console；日志里不允许出现 token（FE-003 第 7 条）。 */
export interface Logger {
  debug(msg: string): void;
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export const silentLogger: Logger = { debug() {}, warn() {}, error() {} };
