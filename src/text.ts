// 文本规则（PRD 3.1、C-26、C-27），与服务端一致：两边跑同一份 protocol/vectors/text.json。

/** 文本消息的最大长度（去首尾空白后的码点数）。 */
export const MAX_TEXT_LENGTH = 5000;

// Unicode White_Space 属性（25 个字符）。不能用 \s：JS 的 \s 还包括 U+FEFF，但它不是 White_Space。
const EDGE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** 去掉首尾空白（含 \n、\t、全角空格 U+3000）。 */
export function trimText(s: string): string {
  return s.replace(EDGE_SPACE, '');
}

/** 按 Unicode 码点计数：emoji 算 1 个，ZWJ 组合 emoji 按组成的码点数计（C-27）。 */
export function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export type TextCheck =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'tooLong'; text: string; over: number };

/** 校验待发送的文本：去空白后为空 → empty；超过 5000 → tooLong（over 为超出的字数，用于"已超出 N 字"提示，C-28）。 */
export function checkText(raw: string): TextCheck {
  const text = trimText(raw);
  const n = countCodePoints(text);
  if (n === 0) return { ok: false, reason: 'empty', text, over: 0 };
  if (n > MAX_TEXT_LENGTH) return { ok: false, reason: 'tooLong', text, over: n - MAX_TEXT_LENGTH };
  return { ok: true, text };
}
