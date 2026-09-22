/**
 * UTF-8 字节工具（Host 与 Client 两侧通用）。
 *
 * 为什么不用 `Buffer`：领域层要能被两侧编译（§12.4 不变量 6），
 * 而 `Buffer` 是 Node 专有；Client 侧只有 `TextEncoder` / `TextDecoder`。
 * 这两个是 Web 标准，Node ≥ 11 也原生支持，因此同一份代码两边都跑。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** 字符串的 UTF-8 字节长度。 */
export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** 编码为字节。 */
export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * 按字节窗口切片，且**不切断多字节字符**。
 *
 * `TextDecoder` 遇到被切断的多字节序列会产出替换字符 `U+FFFD`，
 * 这里统一把尾部残片去掉（宁可少一个字，也不要一个坏字符）。
 */
export function utf8Slice(text: string, start: number, end: number): string {
  const bytes = encoder.encode(text);
  const from = Math.max(0, Math.min(start, bytes.length));
  const to = Math.max(from, Math.min(end, bytes.length));
  const sliced = decoder.decode(bytes.subarray(from, to));
  return sliced.replace(/\uFFFD+$/u, '');
}

/** 按字节上限截断，且不切断多字节字符。 */
export function utf8Truncate(text: string, maxBytes: number): string {
  return utf8Slice(text, 0, maxBytes);
}
