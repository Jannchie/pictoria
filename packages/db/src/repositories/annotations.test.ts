/**
 * record* / retract：写事件与推进队列是**一个**事务。
 *
 * 两步分开时，中途失败会留下半截状态 —— 事件落了库而队列项没标完成（队列会把它再发一遍，
 * 第二次判决看起来像一次重复测量），或者 absolute 一批只落了前几个维度。这里用两种真实的
 * 中途失败把它钉住：事件本身撞上 CHECK 约束，以及推进队列那一步抛错。
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createTempDb, insertPost } from '../__fixtures__/testdb.js'
import { createAbsoluteQueue, createListwiseQueue, createPairwiseQueue } from './annotation-queues.js'
import {
  encodeTimelineCursor,
  insertPairwise,
  listwiseShapeError,
  parseTimelineCursor,
  recordAbsolute,
  recordListwise,
  recordPairwise,
  retractAnnotations,
  timelinePage,
} from './annotations.js'

let sqlite: import('better-sqlite3').Database
let cleanup: () => void

beforeAll(() => {
  ({ sqlite, cleanup } = createTempDb('annotations-tx'))
  for (const id of [1, 2, 3, 4, 5]) insertPost(sqlite, { id })
})

beforeEach(() => {
  for (const t of ['absolute_annotations', 'pairwise_annotations', 'listwise_annotations', 'content_flag_events'])
    sqlite.exec(`DELETE FROM ${t}`)
  for (const t of ['absolute_queue_items', 'pairwise_queue_items', 'listwise_queue_items', 'annotation_queues'])
    sqlite.exec(`DELETE FROM ${t}`)
})

afterAll(() => cleanup())

const count = (table: string): number =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const done = (table: string, queueId: number, position = 0): number =>
  (sqlite.prepare(`SELECT done FROM ${table} WHERE queue_id = ? AND position = ?`).get(queueId, position) as { done: number }).done

/** 让某张队列项表的 UPDATE 失败 —— 模拟"事件写完、推进队列时出错"。 */
function failUpdatesOn(table: string): () => void {
  sqlite.exec(`CREATE TRIGGER boom BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'boom'); END`)
  return () => sqlite.exec('DROP TRIGGER boom')
}

const absolute = (value: number, scale = 5) => ({
  postId: 1,
  dimension: 'overall',
  scale,
  value,
  rubricVersion: 'v1',
  sessionId: 's',
})

const pairwise = { postA: 1, postB: 2, dimension: 'overall', winner: 'a', rubricVersion: 'v1', sessionId: 's' }

it('absolute：成功时事件全部落库，队列项标完成', () => {
  const qid = createAbsoluteQueue(sqlite, { name: 'q', dimensions: ['overall'], scale: 5, postIds: [1] })
  const ids = recordAbsolute(sqlite, { events: [absolute(3), { ...absolute(4), dimension: 'color' }], queueId: qid, queuePosition: 0 })
  expect(ids).toHaveLength(2)
  expect(count('absolute_annotations')).toBe(2)
  expect(done('absolute_queue_items', qid)).toBe(1)
})

it('absolute：一批里第二条撞上 CHECK，第一条也退掉，队列项不动', () => {
  const qid = createAbsoluteQueue(sqlite, { name: 'q', dimensions: ['overall'], scale: 5, postIds: [1] })
  // scale 4 不在 CHECK (scale IN (2, 3, 5)) 里
  expect(() => recordAbsolute(sqlite, { events: [absolute(3), absolute(3, 4)], queueId: qid, queuePosition: 0 }))
    .toThrow(/CHECK/)
  expect(count('absolute_annotations')).toBe(0)
  expect(done('absolute_queue_items', qid)).toBe(0)
})

it('absolute：推进队列那一步抛错，已写的事件回滚', () => {
  const qid = createAbsoluteQueue(sqlite, { name: 'q', dimensions: ['overall'], scale: 5, postIds: [1] })
  const restore = failUpdatesOn('absolute_queue_items')
  try {
    expect(() => recordAbsolute(sqlite, { events: [absolute(3)], queueId: qid, queuePosition: 0 })).toThrow(/boom/)
  }
  finally {
    restore()
  }
  expect(count('absolute_annotations')).toBe(0)
})

it('pairwise：推进队列那一步抛错，事件不落库', () => {
  const qid = createPairwiseQueue(sqlite, { name: 'q', dimensions: ['overall'], pairs: [[1, 2]] })
  const restore = failUpdatesOn('pairwise_queue_items')
  try {
    expect(() => recordPairwise(sqlite, { ...pairwise, queueId: qid, queuePosition: 0 })).toThrow(/boom/)
  }
  finally {
    restore()
  }
  expect(count('pairwise_annotations')).toBe(0)
  expect(done('pairwise_queue_items', qid)).toBe(0)
})

it('listwise：推进队列那一步抛错，事件不落库；成功时两边都生效', () => {
  const qid = createListwiseQueue(sqlite, { name: 'q', dimensions: ['overall'], groups: [[1, 2, 3]] })
  const event = { postIds: [1, 2, 3], ranking: [2, 1, 3], dimension: 'overall', rubricVersion: 'v1', sessionId: 's', queueId: qid, queuePosition: 0 }
  const restore = failUpdatesOn('listwise_queue_items')
  try {
    expect(() => recordListwise(sqlite, event)).toThrow(/boom/)
  }
  finally {
    restore()
  }
  expect(count('listwise_annotations')).toBe(0)

  recordListwise(sqlite, event)
  expect(count('listwise_annotations')).toBe(1)
  expect(done('listwise_queue_items', qid)).toBe(1)
})

it('队列项不存在不是错误：事件照写（与拆分前的行为一致）', () => {
  expect(recordPairwise(sqlite, { ...pairwise, queueId: 9999, queuePosition: 0 })).toBeGreaterThan(0)
  expect(count('pairwise_annotations')).toBe(1)
})

it('只带 queueId 不带 position：按无队列处理', () => {
  const qid = createPairwiseQueue(sqlite, { name: 'q', dimensions: ['overall'], pairs: [[1, 2]] })
  recordPairwise(sqlite, { ...pairwise, queueId: qid, queuePosition: null })
  expect(count('pairwise_annotations')).toBe(1)
  expect(done('pairwise_queue_items', qid)).toBe(0)
})

it('retract：删事件与放回队列项同进同退', () => {
  const qid = createPairwiseQueue(sqlite, { name: 'q', dimensions: ['overall'], pairs: [[1, 2]] })
  const id = recordPairwise(sqlite, { ...pairwise, queueId: qid, queuePosition: 0 })
  expect(done('pairwise_queue_items', qid)).toBe(1)

  const restore = failUpdatesOn('pairwise_queue_items')
  try {
    expect(() => retractAnnotations(sqlite, { kind: 'pairwise', ids: [id], sessionId: 's', queueId: qid, queuePosition: 0 }))
      .toThrow(/boom/)
  }
  finally {
    restore()
  }
  expect(count('pairwise_annotations')).toBe(1)

  expect(retractAnnotations(sqlite, { kind: 'pairwise', ids: [id], sessionId: 's', queueId: qid, queuePosition: 0 })).toBe(1)
  expect(count('pairwise_annotations')).toBe(0)
  expect(done('pairwise_queue_items', qid)).toBe(0)
})

it('retract：空 ids 只取消队列标记（跳过的队列项的 undo）', () => {
  const qid = createPairwiseQueue(sqlite, { name: 'q', dimensions: ['overall'], pairs: [[1, 2]] })
  sqlite.prepare('UPDATE pairwise_queue_items SET done = 1 WHERE queue_id = ?').run(qid)
  expect(retractAnnotations(sqlite, { kind: 'pairwise', ids: [], sessionId: 's', queueId: qid, queuePosition: 0 })).toBe(0)
  expect(done('pairwise_queue_items', qid)).toBe(0)
})

it('listwiseShapeError：重复成员、非排列都拒，空 ranking 是 skip', () => {
  expect(listwiseShapeError({ postIds: [1, 1, 2], ranking: [] })?.field).toBe('postIds')
  expect(listwiseShapeError({ postIds: [1, 2, 3], ranking: [1, 2] })?.field).toBe('ranking')
  expect(listwiseShapeError({ postIds: [1, 2, 3], ranking: [1, 2, 4] })?.field).toBe('ranking')
  expect(listwiseShapeError({ postIds: [1, 2, 3], ranking: [1, 1, 2] })?.field).toBe('ranking')
  expect(listwiseShapeError({ postIds: [1, 2, 3], ranking: [] })).toBeNull()
  expect(listwiseShapeError({ postIds: [1, 2, 3], ranking: [3, 1, 2] })).toBeNull()
})

it('timeline 游标：编码后能原样解析，格式不对给 malformed', () => {
  const cursor = encodeTimelineCursor({ created_at: '2026-10-15 12:00:00', kind: 'pairwise', id: 42 })
  expect(parseTimelineCursor(cursor)).toEqual(['2026-10-15 12:00:00', 'pairwise', 42])
  expect(parseTimelineCursor(null)).toBeNull()
  expect(parseTimelineCursor('')).toBeNull()
  for (const bad of ['a|b', 'a|b|c', 'a||1', 'a|b|1|2'])
    expect(parseTimelineCursor(bad)).toBe('malformed')
})

it('timelinePage：post 已删的事件被剔掉，但游标仍按原始最后一行续', () => {
  insertPost(sqlite, { id: 90 })
  const goneId = insertPairwise(sqlite, { ...pairwise, postA: 3, postB: 90 })
  const keptId = insertPairwise(sqlite, { ...pairwise, postA: 1, postB: 2 })
  sqlite.prepare('DELETE FROM posts WHERE id = 90').run()

  // 同一秒写入，按 id DESC：原始行是 [kept, gone]，gone 被剔掉
  const first = timelinePage(sqlite, { limit: 2 })
  expect(first.entries.map(e => e.id)).toEqual([keptId])
  // 游标停在被剔掉的那条原始行上，而不是最后一条可见条目 —— 否则下一页会把它重新发一遍
  const lastRaw = parseTimelineCursor(first.nextCursor)
  expect(Array.isArray(lastRaw) && lastRaw[2]).toBe(goneId)

  expect(timelinePage(sqlite, { limit: 2, before: lastRaw as [string, string, number] }).entries).toEqual([])
  expect(timelinePage(sqlite, { limit: 0 }).entries).toHaveLength(1) // 夹到 >= 1
})
