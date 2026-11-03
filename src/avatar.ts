// 占位头像（PRD-ui F-UI-21）：各端用同一套规则，保证同一个人在每个端颜色和首字都一样。
// 用例 protocol/vectors/avatar.json（三套 SDK 和各端界面都跑）。

/** FNV-1a 32 位哈希（对 UTF-8 字节）。 */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 调色板下标（0～7）：用户用 userId，群用 groupId。 */
export const avatarColorIndex = (id: string): number => fnv1a32(id) % 8;

/** 首字：显示名去首尾空白后的第一个码点，ASCII 小写字母转大写。 */
export function avatarInitial(name: string): string {
  const first = [...name.trim()][0] ?? '?';
  return /^[a-z]$/.test(first) ? first.toUpperCase() : first;
}
