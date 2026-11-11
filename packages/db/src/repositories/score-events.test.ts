/**
 * 打分事件流：每次用户写 `posts.score`，`post_score_events` 追加一行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqliteHandle } from '../connection.js'
import { createTestDb, insertPost } from '../testing.js'
import { bulkUpdateField, updateField } from './posts.js'

let sqlite: SqliteHandle

beforeEach(() => {
  sqlite = createTestDb()
  for (const id of [100, 101, 200])
    insertPost(sqlite, { id })
  // 101 是 100 的近重复成员
  sqlite.prepare('UPDATE posts SET canonical_post_id = 100 WHERE id = 101').run()
})

afterEach(() => {
  sqlite.close()
})

interface EventRow { post_id: number, score: number, previous: number, bulk: number }

const events = () =>
  sqlite
    .prepare<[], EventRow>('SELECT post_id, score, previous, bulk FROM post_score_events ORDER BY id')
    .all()

describe('打分事件', () => {
  it('单张打分记一行，带上之前的分', () => {
    updateField(sqlite, 200, 'score', 3)
    updateField(sqlite, 200, 'score', 4)

    expect(events()).toEqual([
      { post_id: 200, score: 3, previous: 0, bulk: 0 },
      { post_id: 200, score: 4, previous: 3, bulk: 0 },
    ])
  })

  it('原样重打同一个分也记：那是一次重测', () => {
    updateField(sqlite, 200, 'score', 3)
    updateField(sqlite, 200, 'score', 3)

    expect(events().map(e => [e.score, e.previous])).toEqual([[3, 0], [3, 3]])
  })

  it('镜像到近重复组的写入不记，只记被操作的那张', () => {
    updateField(sqlite, 101, 'score', 5)

    expect(events()).toEqual([{ post_id: 101, score: 5, previous: 0, bulk: 0 }])
  })

  it('批量打分每个 id 一行，标 bulk，previous 是各自原来的分', () => {
    updateField(sqlite, 200, 'score', 2)

    bulkUpdateField(sqlite, [101, 200], 'score', 4)

    expect(events().slice(1)).toEqual([
      { post_id: 101, score: 4, previous: 0, bulk: 1 },
      { post_id: 200, score: 4, previous: 2, bulk: 1 },
    ])
  })

  it('事件带 UTC 时间戳', () => {
    updateField(sqlite, 200, 'score', 3)

    const at = sqlite.prepare('SELECT created_at FROM post_score_events').pluck().get() as string
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('打分情境原样落到 source，缺省是 NULL', () => {
    updateField(sqlite, 200, 'score', 3)
    updateField(sqlite, 200, 'score', 4, 'grade:random')

    expect(sqlite.prepare('SELECT source FROM post_score_events ORDER BY id').pluck().all()).toEqual([null, 'grade:random'])
  })

  it('不存在的 id 不留事件', () => {
    updateField(sqlite, 999_999, 'score', 5)
    bulkUpdateField(sqlite, [999_999], 'score', 5)

    expect(events()).toEqual([])
  })

  it('改别的字段不留事件', () => {
    updateField(sqlite, 200, 'caption', 'x')

    expect(events()).toEqual([])
  })
})
