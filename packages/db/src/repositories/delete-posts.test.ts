/**
 * 删 post 的两件附带事：vec0 行逐条点删，以及引用它的未完成标注队列项被标成完成。
 *
 * 队列项表对 posts 没有外键，post 没了它们还在，而 `next*Items` 是 JOIN posts 取的 ——
 * 不标完成的话这些项永远取不出来，进度条永远停在 `done < total`。
 */
import type Database from 'better-sqlite3'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTempDb, insertPost, insertVector, tagPost } from '../__fixtures__/testdb.js'
import { createAbsoluteQueue, createListwiseQueue, createPairwiseQueue, listQueues, nextPresentableListwiseItems } from './annotation-queues.js'
import { deleteManyReturningPaths } from './posts.js'
import { embeddingBlobs, existingVectors, unitVectors, vectorExists } from './vectors.js'

let sqlite: Database.Database
let cleanup: () => void

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb())
})

afterAll(() => cleanup())

beforeEach(() => {
  for (const t of ['absolute_queue_items', 'pairwise_queue_items', 'listwise_queue_items', 'annotation_queues',
    'absolute_annotations', 'pairwise_annotations', 'listwise_annotations'])
    sqlite.exec(`DELETE FROM ${t}`)
  sqlite.exec('DELETE FROM post_vectors_siglip2')
  sqlite.exec('DELETE FROM post_has_tag')
  sqlite.exec('DELETE FROM posts')
  for (let id = 1; id <= 6; id++)
    insertPost(sqlite, { id })
})

const doneOf = (table: string, qid: number): number[] =>
  (sqlite.prepare(`SELECT done FROM ${table} WHERE queue_id = ? ORDER BY position`).all(qid) as Array<{ done: number }>)
    .map(r => r.done)

describe('deleteManyReturningPaths', () => {
  it('删掉 vec0 行（影子 rowid 表一起清），不碰别的 post 的向量', () => {
    for (const id of [1, 2, 3]) insertVector(sqlite, id)
    tagPost(sqlite, 2, 'x')
    deleteManyReturningPaths(sqlite, [2, 3])
    expect([...existingVectors(sqlite, [1, 2, 3])]).toEqual([1])
    expect(sqlite.prepare('SELECT rowid FROM post_vectors_siglip2_rowids ORDER BY rowid').pluck().all()).toEqual([1])
    expect(sqlite.prepare('SELECT count(*) FROM post_has_tag').pluck().get()).toBe(0)
  })

  it('超过一块（500）的 id 也全部删掉', () => {
    for (let id = 7; id <= 1205; id++) insertPost(sqlite, { id })
    for (const id of [3, 700, 1205]) insertVector(sqlite, id)
    const all = Array.from({ length: 1205 }, (_, i) => i + 1)
    expect(deleteManyReturningPaths(sqlite, all)).toHaveLength(1205)
    expect(sqlite.prepare('SELECT count(*) FROM posts').pluck().get()).toBe(0)
    expect(sqlite.prepare('SELECT count(*) FROM post_vectors_siglip2_rowids').pluck().get()).toBe(0)
  })

  it('引用被删 post 的未完成 absolute/pairwise 项标成完成，listwise 项留给取件时判定', () => {
    const abs = createAbsoluteQueue(sqlite, { name: 'a', dimensions: ['overall'], scale: 5, postIds: [1, 2, 3] })
    const pw = createPairwiseQueue(sqlite, { name: 'p', dimensions: ['overall'], pairs: [[1, 2], [3, 2], [4, 5], [5, 6]] })
    const lw = createListwiseQueue(sqlite, { name: 'l', dimensions: ['overall'], groups: [[1, 3, 4], [5, 6, 2], [4, 5, 6]] })

    deleteManyReturningPaths(sqlite, [2])

    expect(doneOf('absolute_queue_items', abs)).toEqual([0, 1, 0])
    // post_a 命中和 post_b 命中都算
    expect(doneOf('pairwise_queue_items', pw)).toEqual([1, 1, 0, 0])
    // listwise 删一张不关项：剩下的成员够不够排由取件时决定
    expect(doneOf('listwise_queue_items', lw)).toEqual([0, 0, 0])

    const progress = new Map(listQueues(sqlite).map(q => [q.queue.id, [q.total, q.done]]))
    expect(progress.get(abs)).toEqual([3, 1])
    expect(progress.get(pw)).toEqual([4, 2])
    expect(progress.get(lw)).toEqual([3, 0])

    // 只剩两张的那组在取件时被跳过并标完成
    expect(nextPresentableListwiseItems(sqlite, lw, 3).map(i => i.position)).toEqual([0, 2])
    expect(doneOf('listwise_queue_items', lw)).toEqual([0, 1, 0])
  })

  it('不删标注事件行', () => {
    sqlite.prepare(
      'INSERT INTO pairwise_annotations (post_a, post_b, dimension, winner, rubric_version, session_id) '
      + "VALUES (1, 2, 'overall', 'a', 'v1', 's')",
    ).run()
    deleteManyReturningPaths(sqlite, [1, 2])
    expect(sqlite.prepare('SELECT count(*) FROM pairwise_annotations').pluck().get()).toBe(1)
  })
})

describe('向量读取逐 id 点查', () => {
  it('existingVectors / vectorExists 读影子表，结果与 vec0 一致', () => {
    insertVector(sqlite, 1)
    insertVector(sqlite, 4)
    expect([...existingVectors(sqlite, [4, 1, 2, 999])].sort()).toEqual([1, 4])
    expect(existingVectors(sqlite, []).size).toBe(0)
    expect(vectorExists(sqlite, 4)).toBe(true)
    expect(vectorExists(sqlite, 2)).toBe(false)
    sqlite.prepare('DELETE FROM post_vectors_siglip2 WHERE post_id = ?').run(4)
    expect(vectorExists(sqlite, 4)).toBe(false)
  })

  it('embeddingBlobs 原样返回字节，重复 id 只出现一次；unitVectors 是单位长度', () => {
    insertVector(sqlite, 1)
    insertVector(sqlite, 3)
    const blobs = embeddingBlobs(sqlite, [3, 1, 3, 2])
    expect([...blobs.keys()]).toEqual([3, 1])
    expect(blobs.get(1)!.length).toBe(1152 * 4)
    const unit = unitVectors(sqlite, [1, 3, 2])
    expect([...unit.keys()].sort()).toEqual([1, 3])
    let sum = 0
    for (const v of unit.get(1)!) sum += v * v
    expect(sum).toBeCloseTo(1, 5)
  })
})
