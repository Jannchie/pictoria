/**
 * SQL 片段与绑定值的小工具。
 *
 * 之所以单独成文件：`placeholders` 之前在 7 个 repo/query 文件里各写了一遍，
 * 而它的形状被一份冻结的 golden 钉着（见下），复制出去的那几份都没带着这条注释。
 * `chunked` / `serializeFloat32` 同理，各有过三份写法。
 */
import { Buffer } from 'node:buffer'


/** `?,?,?` —— `IN (...)` 的绑定占位符。 */
export function placeholders(n: number): string {
  // 无空格 —— `filters.test.ts` 的 golden 是从已退役的 Python 侧（`','.join('?'*n)`）
  // dump 出来冻结的，SQL 文本逐字符对拍，多一个空格就红。
  return Array.from({ length: n }, () => '?').join(',')
}

/** 条件数组 → `WHERE a AND b`；空数组给空串（拼进查询里正好什么都不加）。 */
export function whereSql(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}

/**
 * 按 `size` 切块 —— `IN (...)` 绑定参数有上限，一块一条查询（或一个事务）。
 *
 * 块大小由调用方决定、各处不同（500 / 900），理由写在各自的调用处。
 */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** sqlite-vec 的 serialize_float32：小端 float32 blob（复制一份，不与入参共享内存）。 */
export function serializeFloat32(values: ArrayLike<number>): Buffer {
  return Buffer.from(new Float32Array(values).buffer)
}
