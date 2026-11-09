/**
 * `order='random'` 的种子洗牌：稳定、换种子就换序、而且真的打散。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SqliteHandle } from '../connection.js'
import { createTestDb } from '../testing.js'
import { searchPosts } from './post-search.js'

const N = 2000
let sqlite: SqliteHandle

beforeAll(() => {
  sqlite = createTestDb()
  const insert = sqlite.prepare(`INSERT INTO posts (file_path, file_name, extension) VALUES ('', ?, 'png')`)
  sqlite.transaction(() => {
    for (let i = 0; i < N; i++) insert.run(`p${i}`)
  })()
})

afterAll(() => sqlite.close())

const shuffled = (seed: number) =>
  searchPosts(sqlite, { order: 'random', orderSeed: seed }, { limit: N }).map(r => r.id as number)

describe('random order', () => {
  it('is a stable permutation per seed, and a different one per seed', () => {
    const a = shuffled(12345)
    expect(new Set(a).size).toBe(N)
    expect(shuffled(12345)).toEqual(a)
    expect(shuffled(67890)).not.toEqual(a)
  })

  it('does not walk the ids in arithmetic progressions', () => {
    // 线性哈希 (id * seed) % P 排出来，相邻 id 差只有 ≤3 种取值。
    for (const seed of [7, 12345, 2_000_000_000]) {
      const ids = shuffled(seed)
      const steps = new Set(ids.slice(1).map((id, i) => id - ids[i]))
      expect(steps.size).toBeGreaterThan(N / 2)
    }
  })
})
