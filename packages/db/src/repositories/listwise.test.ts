/**
 * listwise 标注的存取闭环 —— 队列、事件、timeline、撤回。
 *
 * 排序结果是 JSON 列，schema 层没有任何约束能证明"存进去的组读出来还是那个组"，
 * 所以这条链（建队列 → 取件 → 提交排序 → timeline 可见 → 撤回真删）值得钉在
 * 真实迁移建出来的临时库上。采样（sampleGroups）依赖 silva 分数与向量表，与
 * 既有 pairwise 采样共用未测的路径，不在此列。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'
import { createListwiseQueue, nextListwiseItems } from './annotation-queues.js'
import { annotationTimeline, insertListwise, listListwiseForPost, markQueueItemDone, undoAnnotations } from './annotations.js'

let sqlite: Database.Database
let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-listwise-'))
  sqlite = new Database(path.join(tmpDir, 'test.sqlite'))
  sqliteVec.load(sqlite) // 迁移里有 vec0 虚表
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite, MIGRATIONS_DIR)
  const insert = sqlite.prepare(
    "INSERT INTO posts (id, file_path, file_name, extension, sha256, width, height) VALUES (?, ?, ?, 'jpg', ?, 100, 100)",
  )
  for (const id of [1, 2, 3, 12, 112]) insert.run(id, `p/${id}`, `${id}`, `sha-${id}`)
})

afterAll(() => {
  sqlite.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

it('queue round trip: groups in, parsed groups out, done flag flips', () => {
  const qid = createListwiseQueue(sqlite, { name: 'g', dimensions: ['overall'], groups: [[1, 2, 3], [12, 112]] })
  const items = nextListwiseItems(sqlite, qid)
  expect(items.map(i => i.post_ids)).toEqual([[1, 2, 3], [12, 112]])
  markQueueItemDone(sqlite, qid, { kind: 'listwise', position: 0 })
  expect(nextListwiseItems(sqlite, qid).map(i => i.position)).toEqual([1])
})

it('event round trip: ranking survives, timeline shows the winner as the post', () => {
  const id = insertListwise(sqlite, {
    post_ids: [1, 2, 3],
    ranking: [2, 3, 1],
    dimension: 'overall',
    rubric_version: 'overall-v1',
    session_id: 's1',
  })
  const rows = annotationTimeline(sqlite, { limit: 10 })
  const mine = rows.find(r => r.kind === 'listwise' && r.id === id)!
  expect(mine.post).toBe(2) // 赢家当代表图
  expect(JSON.parse(mine.ranking as string)).toEqual([2, 3, 1])

  // 成员查询精确核对身份：post 12 命中含 12 的组，不误中含 112 的
  insertListwise(sqlite, { post_ids: [12, 112], ranking: [], dimension: 'overall', rubric_version: 'overall-v1', session_id: 's1' })
  expect(listListwiseForPost(sqlite, 12)).toHaveLength(1)
  expect(listListwiseForPost(sqlite, 2)).toHaveLength(1)
})

it('skip uses the first member as the representative post', () => {
  const id = insertListwise(sqlite, { post_ids: [3, 1], ranking: [], dimension: 'overall', rubric_version: 'overall-v1', session_id: 's2' })
  const mine = annotationTimeline(sqlite, { limit: 10 }).find(r => r.kind === 'listwise' && r.id === id)!
  expect(mine.post).toBe(3)
})

it('undo deletes the row for the owning session only', () => {
  const id = insertListwise(sqlite, { post_ids: [1, 2], ranking: [1, 2], dimension: 'overall', rubric_version: 'overall-v1', session_id: 'mine' })
  expect(undoAnnotations(sqlite, { kind: 'listwise', ids: [id], sessionId: 'not-mine' })).toBe(0)
  expect(undoAnnotations(sqlite, { kind: 'listwise', ids: [id], sessionId: 'mine' })).toBe(1)
})
