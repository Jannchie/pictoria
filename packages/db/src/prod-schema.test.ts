/**
 * 把同一套校验打在**真实生产库**上。
 *
 * 上面那个 schema.test.ts 证明"schema.ts 和 migrations 一致"，但生产库是 15 个
 * 迁移在真实历史上跑出来的结果 —— 万一某次迁移在真机上部分失败、或有人手工动过
 * 表，两者就会分叉。这个测试专门盯那种分叉。
 *
 * 库不存在时跳过（CI / 别人的机器上没有这个文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { undeclaredTables, verifySchema } from './verify-schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROD_DB = path.resolve(
  here,
  '../../../server/illustration/images/.pictoria/pictoria.sqlite',
)

const exists = fs.existsSync(PROD_DB)

describe.skipIf(!exists)('手写 schema 对齐真实生产库', () => {
  it('列 / notNull / 主键全部一致', () => {
    expect(verifySchema(PROD_DB).map(m => `${m.table}.[${m.kind}] ${m.detail}`)).toEqual([])
  })

  it('没有漏声明的表（annotation_timeline 是 view，不在此列）', () => {
    expect(undeclaredTables(PROD_DB)).toEqual([])
  })
})
