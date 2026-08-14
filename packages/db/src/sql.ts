/**
 * SQL 片段的小工具。
 *
 * 之所以单独成文件：`placeholders` 之前在 7 个 repo/query 文件里各写了一遍，
 * 而它有一条**跨语言**的约束（见下），复制出去的那几份都没带着这条注释。
 */

/** `?,?,?` —— `IN (...)` 的绑定占位符。 */
export function placeholders(n: number): string {
  // 无空格 —— 与 Python 侧 sql_placeholders 的 ','.join('?'*n) 逐字符一致
  return Array.from({ length: n }, () => '?').join(',')
}

/** 条件数组 → `WHERE a AND b`；空数组给空串（拼进查询里正好什么都不加）。 */
export function whereSql(clauses: string[]): string {
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
}
