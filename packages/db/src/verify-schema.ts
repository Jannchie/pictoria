/**
 * 拿手写的 drizzle schema 和一个真实的 SQLite 库逐列对拍。
 *
 * 存在的理由：schema.ts 是手抄的（`drizzle-kit pull` 在这个库上不可用，见
 * docs/refactor-monorepo-hono.md §4.8），手抄就会抄错，而抄错的后果是运行时
 * 才发现的静默错列 —— 比如把 `notNull` 抄漏，插入时才炸。
 *
 * 比对的是 PRAGMA table_info 给出的真实列，不是 DDL 文本。
 */
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/sqlite-core'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import * as schema from './schema.js'

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  /**
   * 只有 table_xinfo 有这一列：0 普通 / 1 虚表隐藏列 / 2 生成列 VIRTUAL /
   * 3 生成列 STORED。
   *
   * 必须用 table_xinfo 而非 table_info —— 后者**不返回生成列**，会把
   * posts.full_path 和 posts.aspect_ratio 误报成"库里没有"。
   */
  hidden: number
}

export interface Mismatch {
  table: string
  kind: 'missing-table' | 'missing-column' | 'extra-column' | 'notnull' | 'primary-key'
  detail: string
}

/** vec0 的影子表不是我们声明的，跳过。 */
const SHADOW = /^(?:sqlite_|post_vectors_siglip2_)/

export function verifySchema(dbPath: string): Mismatch[] {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  sqliteVec.load(sqlite)

  const mismatches: Mismatch[] = []
  const declared = new Map<string, SQLiteTable>()

  for (const value of Object.values(schema)) {
    // 只挑 sqliteTable()，跳过 customType / 常量
    if (typeof value !== 'object' || value === null)
      continue
    try {
      declared.set(getTableName(value as SQLiteTable), value as SQLiteTable)
    }
    catch {
      // 不是表，忽略
    }
  }

  const live = new Set(
    sqlite
      .prepare<[], { name: string }>(
        `select name from sqlite_master where type = 'table'`,
      )
      .all()
      .map(r => r.name)
      .filter(n => !SHADOW.test(n)),
  )

  for (const [tableName, table] of declared) {
    if (!live.has(tableName)) {
      mismatches.push({ table: tableName, kind: 'missing-table', detail: '库里没有这张表' })
      continue
    }

    const liveCols = sqlite
      .prepare<[], ColumnInfo>(`pragma table_xinfo(${JSON.stringify(tableName)})`)
      .all()
    const liveByName = new Map(liveCols.map(c => [c.name, c]))

    const cfg = getTableConfig(table)
    const generated = new Set(
      cfg.columns.filter(c => c.generated !== undefined).map(c => c.name),
    )
    // 复合主键声明在 table 级，单列主键在列上 —— 两处都要看。
    const declaredPk = new Set<string>([
      ...cfg.columns.filter(c => c.primary).map(c => c.name),
      ...cfg.primaryKeys.flatMap(pk => pk.columns.map(c => c.name)),
    ])

    for (const col of Object.values(getTableColumns(table))) {
      const liveCol = liveByName.get(col.name)
      if (!liveCol) {
        mismatches.push({
          table: tableName,
          kind: 'missing-column',
          detail: `声明了 ${col.name}，库里没有`,
        })
        continue
      }

      // 生成列在 PRAGMA 里 notnull 恒为 0，比它没有意义。
      if (!generated.has(col.name)) {
        const liveNotNull = liveCol.notnull === 1 || liveCol.pk === 1
        const wantNotNull = col.notNull
        if (liveNotNull !== wantNotNull) {
          mismatches.push({
            table: tableName,
            kind: 'notnull',
            detail: `${col.name}: 声明 notNull=${wantNotNull}，库里 notNull=${liveNotNull}`,
          })
        }
      }
    }

    for (const liveCol of liveCols) {
      // hidden=1 是虚表的查询接口列，不是存储列 —— vec0 的 `distance` / `k` 就是
      // 这种，它们只在 `where embedding match ? and k = ?` 里出现，不该被声明。
      if (liveCol.hidden === 1)
        continue
      if (!Object.values(getTableColumns(table)).some(c => c.name === liveCol.name)) {
        mismatches.push({
          table: tableName,
          kind: 'extra-column',
          detail: `库里有 ${liveCol.name}，schema 没声明`,
        })
      }
    }

    const livePk = new Set(liveCols.filter(c => c.pk > 0 && c.hidden !== 1).map(c => c.name))
    const pkSame
      = livePk.size === declaredPk.size && [...livePk].every(n => declaredPk.has(n))
    if (!pkSame) {
      mismatches.push({
        table: tableName,
        kind: 'primary-key',
        detail: `声明 [${[...declaredPk].sort().join(', ')}]，库里 [${[...livePk].sort().join(', ')}]`,
      })
    }
  }

  sqlite.close()
  return mismatches
}

/** 库里存在、但 schema.ts 没声明的表（提示用，不算错误）。 */
export function undeclaredTables(dbPath: string): string[] {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  sqliteVec.load(sqlite)
  const declared = new Set<string>()
  for (const value of Object.values(schema)) {
    if (typeof value !== 'object' || value === null)
      continue
    try {
      declared.add(getTableName(value as SQLiteTable))
    }
    catch { /* 不是表 */ }
  }
  const out = sqlite
    .prepare<[], { name: string }>(`select name from sqlite_master where type = 'table'`)
    .all()
    .map(r => r.name)
    .filter(n => !SHADOW.test(n) && !declared.has(n))
  sqlite.close()
  return out
}
