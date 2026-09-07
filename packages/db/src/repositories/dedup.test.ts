/**
 * 近重复分组的数据侧 —— 导出、union-find 分配、原子换组。
 *
 * 这三段是 dedup 里**不需要 GPU** 的全部，也正因如此值得单独钉住：矩阵乘的对错
 * 靠 `pnpm parity:worker` 的逐位对拍，而"谁当 canonical、链会不会被并起来、一条弱边
 * 能不能串起两坨、重建过程中库里能不能看到半成品"这些是纯逻辑，跑一次真实迁移
 * 建出来的临时库就能证明。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'
import type { VariantEdge } from './dedup.js'
import { assignFromEdges, exportVectorMatrix, replaceAllGroups } from './dedup.js'

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

/** 一条边，strength 默认 1（worker 目前只回传"在阈值内"，不回传距离）。 */
function edge(a: number, b: number, strength = 1): VariantEdge {
  return { a, b, strength }
}

/** 分配结果的顺序取决于 Map 的遍历，比较之前先排序。 */
function sorted(out: Array<[number, number]>): Array<[number, number]> {
  return [...out].sort((x, y) => x[0] - y[0] || x[1] - y[1])
}

describe('union-find 分配', () => {
  it('簇里 id 最小的那个当 canonical', () => {
    expect(sorted(assignFromEdges([edge(10, 20), edge(10, 30), edge(20, 30)])))
      .toEqual([[20, 10], [30, 10]])
  })

  it('链式相似传递成一组 —— A–B、B–C 像，A–C 不像也在同一组', () => {
    // 差分集就是这个形状（原图 → 换表情 → 换表情 + 对白）：首尾两张离得比阈值远。
    // 旧的星形贪心在这里会把 3 扔在组外，那是一层与信号无关的漏检。
    expect(sorted(assignFromEdges([edge(1, 2), edge(2, 3)])))
      .toEqual([[2, 1], [3, 1]])
  })

  it('更长的链照样是一个连通分量', () => {
    expect(sorted(assignFromEdges([edge(1, 2), edge(2, 3), edge(3, 4), edge(4, 5)])))
      .toEqual([[2, 1], [3, 1], [4, 1], [5, 1]])
  })

  it('maxGroupSize 到顶时跳过那条边，已有的组不受影响', () => {
    // 1-2-3 先满三个位；1-4 撞上限被跳过 —— 4 落单，而不是把 3 挤出去，
    // 也不是把整个组作废。
    const out = assignFromEdges([edge(1, 2), edge(1, 3), edge(1, 4)], { maxGroupSize: 3 })
    expect(sorted(out)).toEqual([[2, 1], [3, 1]])
  })

  it('两个满员的组不会被一条边缝成一个巨无霸', () => {
    const out = assignFromEdges(
      [edge(1, 2), edge(3, 4), edge(2, 3, 0.1)],
      { maxGroupSize: 2 },
    )
    expect(sorted(out)).toEqual([[2, 1], [4, 3]])
  })

  it('excluded 的 post 不进任何组', () => {
    // 2 是用户拆出来的：它和 1 再像也不再被并回去，而 1-3 照常成组。
    const out = assignFromEdges([edge(1, 2), edge(1, 3)], { excluded: new Set([2]) })
    expect(sorted(out)).toEqual([[3, 1]])
  })

  it('excluded 不当桥 —— 经过它的链不会被接起来', () => {
    expect(assignFromEdges([edge(1, 2), edge(2, 3)], { excluded: new Set([2]) })).toEqual([])
  })

  it('pinned 成员胜过 min id', () => {
    const out = assignFromEdges([edge(1, 2), edge(2, 3)], { pinned: new Set([3]) })
    expect(sorted(out)).toEqual([[1, 3], [2, 3]])
  })

  it('一组里有多个 pinned 时取最小 id —— 结果不依赖遍历顺序', () => {
    const out = assignFromEdges([edge(1, 2), edge(2, 3)], { pinned: new Set([2, 3]) })
    expect(sorted(out)).toEqual([[1, 2], [3, 2]])
  })

  it('边按 strength 降序处理 —— 被闸掉的是弱的那条', () => {
    // 3 同时和 1（弱）、2（强）像，但组只能装两个：强边先落袋。
    const out = assignFromEdges(
      [edge(1, 3, 0.5), edge(2, 3, 0.9)],
      { maxGroupSize: 2 },
    )
    expect(out).toEqual([[3, 2]])
    // 反过来喂同样两条边，结果必须一样 —— 排序基于 strength，不是输入顺序
    const reversed = assignFromEdges(
      [edge(2, 3, 0.9), edge(1, 3, 0.5)],
      { maxGroupSize: 2 },
    )
    expect(reversed).toEqual([[3, 2]])
  })

  it('反向边和自环是输入，不是承诺 —— 照样规整', () => {
    // worker 承诺回传上三角，但它跨了一个进程边界；反着给也要得到同样的结果
    expect(assignFromEdges([edge(8, 7)])).toEqual([[8, 7]])
    expect(assignFromEdges([edge(7, 7)])).toEqual([])
  })

  it('重复的边不会把组算大', () => {
    const out = assignFromEdges([edge(1, 2), edge(2, 1), edge(1, 2)], { maxGroupSize: 2 })
    expect(out).toEqual([[2, 1]])
  })

  it('没有近邻就没有分组', () => {
    expect(assignFromEdges([])).toEqual([])
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

    // 升序不是为了好看：worker 回传的是行下标，行序一抖，同一个库两次重建
    // 就会得到不同的边序（进而不同的组）
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

  it('canonical 在计算期间被删掉时丢弃那一组，其余照常写入', () => {
    for (const id of [1, 2, 3]) insertPost(id)
    replaceAllGroups(sqlite, [[2, 1]])

    // `assignments` 基于几分钟前的快照，期间 999 被 sync / 用户删掉了。
    // canonical_post_id 有 FK，硬写会让整个事务回滚、分钟级的 GPU 白算 ——
    // 所以死 canonical 的组被丢弃（成员保持独立），活着的照常。
    replaceAllGroups(sqlite, [[1, 999], [2, 999], [3, 1]])
    expect([canonicalOf(1), canonicalOf(2), canonicalOf(3)]).toEqual([null, null, 1])
  })

  it('member 在计算期间被删掉时那条 UPDATE 是空操作', () => {
    for (const id of [1, 2]) insertPost(id)
    // 999 是快照里有、现在没了的成员：UPDATE 匹配 0 行，天然无害，不需要过滤。
    expect(() => replaceAllGroups(sqlite, [[999, 1], [2, 1]])).not.toThrow()
    expect(canonicalOf(2)).toBe(1)
  })
})
