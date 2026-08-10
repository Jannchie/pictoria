/**
 * 把 buildWhere 的产物真的打到**生产库**上，对拍计数与前 20 个 id。
 *
 * filters.test.ts 证明的是"SQL 文本一致"，这个证明的是"跑出来一样" —— 参数绑定
 * 顺序、类型转换、LEFT JOIN 之后 WHERE 的语义，这些都可能在两侧分叉而 SQL 文本
 * 却看不出来。
 *
 * 固件由 scratchpad/dump_counts.py 从 Python 侧 dump。库不存在时整组跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import golden from './__fixtures__/counts-golden.json' with { type: 'json' }
import { buildWhere, type PostFilter } from './filters.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROD_DB = path.resolve(here, '../../../server/illustration/images/.pictoria/pictoria.sqlite')
const exists = fs.existsSync(PROD_DB)

interface CountCase {
  name: string
  filter: Record<string, unknown>
  count: number
  first_ids: number[]
}
const cases = golden as unknown as CountCase[]

let sqlite: Database.Database

beforeAll(() => {
  if (!exists) return
  sqlite = new Database(PROD_DB, { readonly: true, fileMustExist: true })
  sqliteVec.load(sqlite)
  sqlite.pragma('foreign_keys = ON')
})

afterAll(() => sqlite?.close())

describe.skipIf(!exists)('buildWhere 打在生产库上与 Python 结果一致', () => {
  it.each(cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
    const { where, params, joins } = buildWhere(c.filter as PostFilter)
    const joinSql = joins.join(' ')
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ''

    const { n } = sqlite
      .prepare<unknown[], { n: number }>(`SELECT COUNT(*) n FROM posts p ${joinSql}${whereSql}`)
      .get(...params)!
    expect(n).toBe(c.count)

    const ids = sqlite
      .prepare<unknown[], { id: number }>(
        `SELECT p.id FROM posts p ${joinSql}${whereSql} ORDER BY p.id LIMIT 20`,
      )
      .all(...params)
      .map(r => r.id)
    expect(ids).toEqual(c.first_ids)
  })
})
