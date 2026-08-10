/**
 * 跨语言 payload 里传向量用的编码。
 *
 * cairnq 的 payload 是一个 JSON 列，而 D1 定下的原则是 **worker 只算不写、也不读库**
 * —— 于是 silva 这类"输入是已存向量"的 worker，向量必须**随 payload 一起走**。
 *
 * 用 base64 的原始 float32 而不是 JSON 数字数组，两个理由：
 *
 * * **体积**：1152 维 float32 = 4608 字节 → base64 6144 字符。同一个向量写成 JSON
 *   数组是约 21 KB（每个数 `-0.0123456789` 级别的十进制），**3.4 倍**。silva 一批
 *   64 条时是 384 KB 对 1.3 MB。
 * * **精度**：base64 是 float32 的逐位副本，来回一趟逐字节相同。JSON 数字要经过
 *   float32 → double → 十进制文本 → double → float32，中间那步十进制是有损的
 *   （Python 的 repr 给的是最短往返表示，而 JS 的 Number→String 规则不同），
 *   两侧对不齐时表现为分数末位漂移，正是最难查的那种不一致。
 *
 * Python 侧的对应实现在 `worker/codec.py`（`np.frombuffer` / `base64.b64encode`），
 * 两边由 `packages/contracts/src/codec.test.ts` 里的定值向量钉住。
 */

/** `Float32Array` → base64。字节序是平台原生的小端，两侧都跑在 x86/ARM 上。 */
export function encodeVector(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64')
}

/** base64 → `Float32Array`。 */
export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  // `buf.buffer` 可能是共享池的一块，必须带 byteOffset 且按长度切
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
}

/** SQLite BLOB（vec0 存的就是这个）→ base64，中间不做数值转换。 */
export function encodeVectorBlob(blob: Buffer): string {
  return blob.toString('base64')
}
