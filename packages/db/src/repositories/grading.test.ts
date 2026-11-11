/**
 * 快速打分页的选图与一致度。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SqliteHandle } from '../connection.js'
import { createTestDb, insertPost } from '../testing.js'
import { gradingAnchors, gradingStats, sampleGradingDeck } from './grading.js'
import { updateField } from './posts.js'

let sqlite: SqliteHandle

/** 确定性的 rng，让抽样可复现。 */
function seeded(seed = 1): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function silva(id: number, score: number) {
  sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, \'silva\', ?)').run(id, score)
}

beforeEach(() => {
  sqlite = createTestDb()
})

afterEach(() => {
  sqlite.close()
})

/** 200 张已打分（其中 20 张与模型严重分歧）+ 200 张没打分。 */
function seedLibrary() {
  for (let i = 0; i < 200; i++) {
    const id = 1000 + i
    const disputed = i < 20
    insertPost(sqlite, { id, score: disputed ? 5 : 3 })
    silva(id, disputed ? 0.3 : 0.5) // 模型档位：存疑的 2.2（人工 5），其余 3（人工 3）
  }
  for (let i = 0; i < 200; i++) {
    insertPost(sqlite, { id: 2000 + i })
    silva(2000 + i, i < 190 ? 0.5 : 0.95) // 新图九成五在 3 档，只有 10 张在 5 档
  }
}

describe('sampleGradingDeck', () => {
  it('按 8:1:1 混新图 / 随机重打 / 存疑重打', () => {
    seedLibrary()

    const deck = sampleGradingDeck(sqlite, 30, seeded())

    const count = (r: string) => deck.filter(p => p.reason === r).length
    expect([count('new'), count('random'), count('suspect')]).toEqual([24, 3, 3])
    expect(new Set(deck.map(p => p.postId)).size).toBe(30)
  })

  it('存疑的只从与模型分歧的图里出', () => {
    seedLibrary()

    const suspects = sampleGradingDeck(sqlite, 30, seeded()).filter(p => p.reason === 'suspect')

    expect(suspects.every(p => p.postId < 1020)).toBe(true)
    expect(suspects.every(p => p.previous === 5 && p.model === 2)).toBe(true)
  })

  it('新图按模型档位均摊，稀有的一端被多抽', () => {
    seedLibrary()

    const fresh = sampleGradingDeck(sqlite, 30, seeded()).filter(p => p.reason === 'new')

    // 5 档只占新图的 5%（一共 10 张）：均摊会把这一档抽干
    expect(fresh.filter(p => p.model === 5).length).toBe(10)
    expect(fresh.every(p => p.previous === 0)).toBe(true)
  })

  it('一周内动过分的图（连同它的近重复组）不再出现', () => {
    insertPost(sqlite, { id: 1, score: 3 })
    insertPost(sqlite, { id: 2, score: 3 })
    insertPost(sqlite, { id: 3, score: 3 })
    sqlite.prepare('UPDATE posts SET canonical_post_id = 2 WHERE id = 3').run()
    updateField(sqlite, 3, 'score', 4) // 打的是成员 3，代表 2 也该歇着

    expect(sampleGradingDeck(sqlite, 10, seeded()).map(p => p.postId)).toEqual([1])
  })

  it('只抽组代表', () => {
    insertPost(sqlite, { id: 1 })
    insertPost(sqlite, { id: 2 })
    sqlite.prepare('UPDATE posts SET canonical_post_id = 1 WHERE id = 2').run()

    expect(sampleGradingDeck(sqlite, 10, seeded()).map(p => p.postId)).toEqual([1])
  })

  it('没有模型分时，存疑的份额由随机重打补上', () => {
    for (let i = 0; i < 50; i++)
      insertPost(sqlite, { id: 100 + i, score: 3 })

    const deck = sampleGradingDeck(sqlite, 10, seeded())

    expect(deck.length).toBe(10)
    expect(deck.every(p => p.reason === 'random' && p.model === null)).toBe(true)
  })
})

describe('gradingAnchors', () => {
  /** 每档 5 张、各在不同目录，模型分离档位中心由近到远。 */
  function seedAnchorable() {
    let id = 1
    for (const g of [1, 2, 3, 4, 5]) {
      for (let k = 0; k < 5; k++, id++) {
        sqlite
          .prepare('INSERT INTO posts (id, file_path, file_name, extension, width, height, score, rating) VALUES (?, ?, ?, \'jpg\', 1, 1, ?, 1)')
          .run(id, `artist${id}`, `f${id}`, g)
        silva(id, (g - 1) / 4 + k * 0.01)
      }
    }
  }

  it('每档选三张：人工分是这一档、模型分离它最近的', () => {
    seedAnchorable()

    const anchors = gradingAnchors(sqlite)

    expect(anchors.filter(a => a.grade === 3).map(a => a.postId)).toEqual([11, 12, 13])
    expect(anchors.map(a => a.grade)).toEqual([5, 5, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1])
  })

  it('选定之后不再变：模型分变了也还是原来那几张', () => {
    seedAnchorable()
    const before = gradingAnchors(sqlite)

    sqlite.prepare('UPDATE post_aesthetic_scores SET score = 0.9 WHERE post_id IN (11, 12, 13)').run()

    expect(gradingAnchors(sqlite)).toEqual(before)
  })

  it('一张锚点改了分就失效，只补这一个位置', () => {
    seedAnchorable()
    gradingAnchors(sqlite)

    sqlite.prepare('UPDATE posts SET score = 4 WHERE id = 12').run()

    expect(gradingAnchors(sqlite).filter(a => a.grade === 3).map(a => a.postId)).toEqual([11, 14, 13])
  })

  it('同一个目录只出一张', () => {
    for (const id of [1, 2, 3, 4]) {
      sqlite
        .prepare('INSERT INTO posts (id, file_path, file_name, extension, width, height, score, rating) VALUES (?, ?, ?, \'jpg\', 1, 1, 3, 1)')
        .run(id, id < 4 ? 'same' : 'other', `f${id}`)
      silva(id, 0.5)
    }

    expect(gradingAnchors(sqlite).map(a => a.postId)).toEqual([1, 4])
  })

  it('不选 rating 3 以上的图', () => {
    sqlite.prepare('INSERT INTO posts (id, file_path, file_name, extension, width, height, score, rating) VALUES (1, \'a\', \'f\', \'jpg\', 1, 1, 3, 4)').run()
    silva(1, 0.5)

    expect(gradingAnchors(sqlite)).toEqual([])
  })

  it('参照图不会被抽进牌里', () => {
    seedAnchorable()
    const anchored = new Set(gradingAnchors(sqlite).map(a => a.postId))

    const deck = sampleGradingDeck(sqlite, 25, seeded())

    expect(deck.length).toBe(10)
    expect(deck.some(p => anchored.has(p.postId))).toBe(false)
  })
})

describe('gradingStats', () => {
  it('自洽度只算随机重打；模型一致度只算新图', () => {
    for (const id of [1, 2, 3, 4, 5])
      insertPost(sqlite, { id, score: id <= 3 ? 3 : 0 })
    silva(4, 0.75) // 模型 4 档
    silva(5, 0.75)

    updateField(sqlite, 1, 'score', 3, 'grade:random') // 同档
    updateField(sqlite, 2, 'score', 5, 'grade:random') // 差两档
    updateField(sqlite, 3, 'score', 1, 'grade:suspect') // 不计入自洽度
    updateField(sqlite, 4, 'score', 4, 'grade:new') // 与模型同档
    updateField(sqlite, 5, 'score', 3, 'grade:new') // 与模型差一档
    updateField(sqlite, 5, 'score', 2) // 图库里打的，不计

    expect(gradingStats(sqlite)).toEqual({
      gradedToday: 5,
      self: { n: 2, exact: 0.5, far: 0.5 },
      model: { n: 2, exact: 0.5, far: 0 },
    })
  })

  it('还没有数据时比例是 null 而不是 0', () => {
    expect(gradingStats(sqlite)).toEqual({
      gradedToday: 0,
      self: { n: 0, exact: null, far: null },
      model: { n: 0, exact: null, far: null },
    })
  })
})
