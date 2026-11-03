// 从 protocol/errors.json（错误码唯一真相源）生成 src/errors.gen.ts。
// 用法：node scripts/gen-errors.mjs（--check 时只比较，不一致则退出码 1，供 CI 使用）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = fileURLToPath(new URL('../src/errors.gen.ts', import.meta.url));

export function render(spec) {
  const lines = [
    '// 由 scripts/gen-errors.mjs 从 protocol/errors.json 生成，不要手改。',
    '',
    '/** 错误码。 */',
    'export const ErrorCode = {',
    ...spec.errors.map((e) => `  ${e.name}: ${e.code},`),
    '} as const;',
    'export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];',
    '',
    '/** 错误码的详细信息：是否可以重试、给开发者的说明。 */',
    'export const ERROR_INFO: Readonly<Record<number, { name: string; retryable: boolean; message: string }>> = {',
    ...spec.errors.map(
      (e) =>
        `  ${e.code}: { name: ${JSON.stringify(e.name)}, retryable: ${e.retryable}, message: ${JSON.stringify(e.message)} },`,
    ),
    '};',
    '',
    '/** WebSocket 关闭码。 */',
    'export const CloseCode = {',
    ...spec.closeCodes.map((c) => `  ${c.name}: ${c.code},`),
    '} as const;',
    '',
    '/** 关闭后是否应该自动重连（未列出的关闭码按可以重连处理）。 */',
    'export const CLOSE_RECONNECT: Readonly<Record<number, boolean>> = {',
    ...spec.closeCodes.map((c) => `  ${c.code}: ${c.reconnect},`),
    '};',
    '',
    '/** 被踢原因 → 关闭码（null 表示保留值，一期不出现）。 */',
    'export const KICK_CLOSE_CODE: Readonly<Record<string, number | null>> = {',
    ...spec.kickReasons.map((k) => `  ${k.reason}: ${k.closeCode},`),
    '};',
    '',
  ];
  return lines.join('\n');
}

const spec = JSON.parse(readFileSync(root + 'protocol/errors.json', 'utf8'));
const text = render(spec);
if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== text) {
    console.error('src/errors.gen.ts is out of date; run npm run gen:errors');
    process.exit(1);
  }
} else {
  writeFileSync(out, text);
}
