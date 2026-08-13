/**
 * 近重复分组的数据侧 —— 导出、贪心分配、原子换组。
 *
 * 这三段是 dedup 里**不需要 GPU** 的全部，也正因如此值得单独钉住：矩阵乘的对错
 * 靠 `pnpm parity:worker` 的逐位对拍，而"谁当 canonical、组会不会成链、重建过程中
 * 库里能不能看到半成品"这些是纯逻辑，跑一次真实迁移建出来的临时库就能证明。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'
import { assignFromPairs, exportVectorMatrix, replaceAllGroups } from './dedup.js'

const here = path.dirname(fileURLToPath(import.meta.url))


let sqlite: Database.Database
let tmpDir: string

/** 一条 1152 维的单位向量，`seed` 决定它指向哪儿。 */
function unitBlob(seed: number): Buffer {
  const vec = new Float32Array(1152)
  for (let i = 0; i < vec.length; i++) vec[i] = Math.sin(seed * 7.13 + i * 0.011)
  let sum = 0
  for (const v of vec) sum += v * v
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm
  return Buffer.from(vec.buffer)
}

function insertPost(id: number): void {
  sqlite
    .prepare(
      'INSERT INTO posts (id, file_path, file_name, extension, width, height) VALUES (?, ?, ?, \'jpg\', 100, 100)',
    )
    .run(id, 'dir', `f${id}`)
}

function insertVector(id: number, blob = unitBlob(id)): void {
  sqlite
    .prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)')
    .run(BigInt(id), blob)
}

function canonicalOf(id: number): number | null {
  return sqlite
    .prepare<[number], { canonical_post_id: number | null }>(
      'SELECT canonical_post_id FROM posts WHERE id = ?',
    )
    .get(id)!.canonical_post_id
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-dedup-'))
  sqlite = new Database(path.join(tmpDir, 'test.sqlite'))
  sqliteVec.load(sqlite)
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite, MIGRATIONS_DIR)
})

afterAll(() => {
  sqlite.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['post_vectors_siglip2', 'posts']) sqlite.exec(`DELETE FROM ${t}`)
})

describe('贪心分配', () => {
  it('簇里 id 最小的那个当 canonical', () => {
    // 0-1-2 互为近邻（下标即 id 序）
    const ids = [10, 20, 30]
    const pairs: Array<[number, number]> = [[0, 1], [0, 2], [1, 2]]
    expect(assignFromPairs(ids, pairs).sort()).toEqual([[20, 10], [30, 10]].sort())
  })

  it('组只有一层，永远不成链', () => {
    // 0-1 近，1-2 近，但 0-2 不近。1 被 0 认领之后不能再成为 2 的种子，
    // 于是 2 保持独立 —— 而不是变成"指向 1，而 1 指向 0"的链。
    const ids = [1, 2, 3]
    expect(assignFromPairs(ids, [[0, 1], [1, 2]])).toEqual([[2, 1]])
  })

  it('已被认领的成员不会被第二个种子抢走', () => {
    // 0 先认领 2；3 也和 2 近，但 2 已经名花有主
    const ids = [1, 2, 3, 4]
    const out = new Map(assignFromPairs(ids, [[0, 2], [3, 2]]).map(([m, c]) => [m, c]))
    expect(out.get(3)).toBe(1)
    expect(out.has(4)).toBe(false)
  })

  it('下三角和自环是输入，不是承诺 —— 照样规整', () => {
    // worker 承诺回传上三角，但它跨了一个进程边界；反着给也要得到同样的结果
    const ids = [7, 8]
    expect(assignFromPairs(ids, [[1, 0]])).toEqual([[8, 7]])
    expect(assignFromPairs(ids, [[0, 0]])).toEqual([])
  })

  it('没有近邻就没有分组', () => {
    expect(assignFromPairs([1, 2, 3], [])).toEqual([])
  })
})

describe('向量导出', () => {
  it('按 post_id 升序写出裸 float32，行序与返回的 ids 平行', () => {
    for (const id of [30, 10, 20]) {
      insertPost(id)
      insertVector(id)
    }
    const file = path.join(tmpDir, 'm.f32')
    const { ids, count, dim } = exportVectorMatrix(sqlite, file)

    // 升序不是为了好看：贪心分配按行下标从小到大跑，行序即 id 序才能保证
    // 簇里最早的 post 拿到 canonical 位
    expect(ids).toEqual([10, 20, 30])
    expect(count).toBe(3)
    expect(dim).toBe(1152)

    const raw = fs.readFileSync(file)
    expect(raw.length).toBe(3 * 1152 * 4)
    // 第二行应该逐字节等于 20 的 blob
    expect(raw.subarray(1152 * 4, 1152 * 8)).toEqual(unitBlob(20))
  })

  it('空库导出零字节', () => {
    const file = path.join(tmpDir, 'empty.f32')
    expect(exportVectorMatrix(sqlite, file)).toEqual({ ids: [], count: 0, dim: 0 })
    expect(fs.readFileSync(file).length).toBe(0)
  })
})

describe('原子换组', () => {
  it('清空旧指针再写新的', () => {
    for (const id of [1, 2, 3]) insertPost(id)
    replaceAllGroups(sqlite, [[2, 1], [3, 1]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([null, 1, 1])

    // 第二次重建把 3 挪出去 —— 旧指针必须消失，而不是叠加
    replaceAllGroups(sqlite, [[2, 1]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([null, 1, null])

    replaceAllGroups(sqlite, [])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([null, null, null])
  })

  it('一条写不进去就整体回滚 —— 读者永远看不到半成品', () => {
    for (const id of [1, 2]) insertPost(id)
    replaceAllGroups(sqlite, [[2, 1]])

    // canonical_post_id 有 FK；指向不存在的 post 会在 executemany 中途炸掉。
    // 分成两步做的话，清空已经生效而新指针只写了一半。
    expect(() => replaceAllGroups(sqlite, [[1, 999], [2, 1]])).toThrow()
    expect(canonicalOf(2)).toBe(1)
  })
})
