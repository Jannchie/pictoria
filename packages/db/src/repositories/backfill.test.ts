/**
 * backfill 的待办查询与落库 —— 在一个由真实迁移建出来的临时库上跑。
 *
 * 这两个函数是 §D1 里"所有数据库写入在 TS"的落点，也是唯一会自动写生产库的
 * 新代码路径。它们此前没有任何测试，而"服务跑起来没报错"证明不了待办查询挑对了
 * 东西 —— 生产库上 silva 已经打满，那条路径在真机上根本没被走到过。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../migrate.js'
import {
  aestheticWorkerKey,
  fetchEmbeddingBlobs,
  listSilvaPending,
  listWaifuPending,
  recordFailures,
  upsertAestheticScores,
  upsertWaifuScores,
} from './backfill.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.resolve(here, '../../../../server/migrations')

let sqlite: Database.Database
let tmpDir: string

/** 一个可辨识的 1152 维向量，序列化成 vec0 存的那种 float32 blob。 */
function vectorBlob(seed: number): Buffer {
  const vec = new Float32Array(1152)
  for (let i = 0; i < vec.length; i++) vec[i] = (seed + i) / 10000
  return Buffer.from(vec.buffer)
}

function insertPost(id: number, extension = 'jpg'): void {
  sqlite
    .prepare(
      'INSERT INTO posts (id, file_path, file_name, extension, width, height) VALUES (?, ?, ?, ?, 100, 100)',
    )
    .run(id, 'dir', `f${id}`, extension)
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-backfill-'))
  sqlite = new Database(path.join(tmpDir, 'test.sqlite'))
  sqliteVec.load(sqlite)
  sqlite.pragma('foreign_keys = ON')
  runMigrations(sqlite, MIGRATIONS)
})

afterAll(() => {
  sqlite.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  for (const t of ['post_aesthetic_scores', 'post_process_failures', 'post_vectors_siglip2', 'posts'])
    sqlite.exec(`DELETE FROM ${t}`)
})

describe('silva 待办查询', () => {
  it('只挑有向量、还没这个 scorer 分数的 post', () => {
    for (const id of [1, 2, 3]) insertPost(id)
    // 1 有向量没分 → 待办；2 有向量有分 → 不是；3 没向量 → 不是
    for (const id of [1, 2])
      sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), vectorBlob(id))
    sqlite.prepare('INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (2, \'silva\', 0.5)').run()

    expect(listSilvaPending(sqlite, 'silva')).toEqual([1])
  })

  it('两个 scorer 各算各的', () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(1), vectorBlob(1))
    sqlite.prepare('INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (1, \'silva\', 0.5)').run()

    expect(listSilvaPending(sqlite, 'silva')).toEqual([])
    expect(listSilvaPending(sqlite, 'silva_luna')).toEqual([1])
  })

  it('被拉黑的 post 不再出现', () => {
    for (const id of [1, 2]) {
      insertPost(id)
      sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), vectorBlob(id))
    }
    sqlite
      .prepare('INSERT INTO post_process_failures(post_id, worker, error) VALUES (?, ?, ?)')
      .run(2, aestheticWorkerKey('silva'), 'boom')

    expect(listSilvaPending(sqlite, 'silva')).toEqual([1])
    // 黑名单是按 worker 桶分的，另一个 scorer 不受影响
    expect(listSilvaPending(sqlite, 'silva_luna')).toEqual([1, 2])
  })

  it('按 id 升序，limit 截断的是前缀', () => {
    for (const id of [5, 3, 1, 4, 2]) {
      insertPost(id)
      sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), vectorBlob(id))
    }
    expect(listSilvaPending(sqlite, 'silva')).toEqual([1, 2, 3, 4, 5])
    expect(listSilvaPending(sqlite, 'silva', 3)).toEqual([1, 2, 3])
  })
})

describe('向量取回', () => {
  it('取回的字节与写进去的逐字节相同', () => {
    insertPost(1)
    const blob = vectorBlob(7)
    sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(1), blob)

    const got = fetchEmbeddingBlobs(sqlite, [1]).get(1)!
    // 这是整条链路的地基：payload 里传的就是这段字节的 base64，中间不做数值转换
    expect(Buffer.compare(got, blob)).toBe(0)
    expect(got.length).toBe(1152 * 4)
  })

  it('id 不存在就不在结果里，不抛', () => {
    expect(fetchEmbeddingBlobs(sqlite, [999]).size).toBe(0)
    expect(fetchEmbeddingBlobs(sqlite, []).size).toBe(0)
  })
})

describe('分数落库', () => {
  beforeEach(() => {
    for (const id of [1, 2]) insertPost(id)
  })

  it('写入后待办查询就不再返回它', () => {
    for (const id of [1, 2])
      sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), vectorBlob(id))
    expect(listSilvaPending(sqlite, 'silva')).toEqual([1, 2])

    upsertAestheticScores(sqlite, 'silva', [{ postId: 1, score: 0.25 }])
    expect(listSilvaPending(sqlite, 'silva')).toEqual([2])
  })

  it('重复写入是更新而不是插第二行', () => {
    upsertAestheticScores(sqlite, 'silva', [{ postId: 1, score: 0.25 }])
    upsertAestheticScores(sqlite, 'silva', [{ postId: 1, score: 0.75 }])

    const rows = sqlite
      .prepare<[], { score: number }>('SELECT score FROM post_aesthetic_scores WHERE post_id = 1 AND scorer = \'silva\'')
      .all()
    expect(rows).toEqual([{ score: 0.75 }])
  })

  it('两个 scorer 的分数并存', () => {
    upsertAestheticScores(sqlite, 'silva', [{ postId: 1, score: 0.25 }])
    upsertAestheticScores(sqlite, 'silva_luna', [{ postId: 1, score: 0.75 }])

    const rows = sqlite
      .prepare<[], { scorer: string, score: number }>(
        'SELECT scorer, score FROM post_aesthetic_scores WHERE post_id = 1 ORDER BY scorer',
      )
      .all()
    expect(rows).toEqual([{ scorer: 'silva', score: 0.25 }, { scorer: 'silva_luna', score: 0.75 }])
  })

  it('空列表是空操作', () => {
    upsertAestheticScores(sqlite, 'silva', [])
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_aesthetic_scores').get()!.n).toBe(0)
  })

  it('一批里有一条违反外键时整批回滚', () => {
    // post 999 不存在 —— 事务的意义就在这里：不能落下半批分数，让待办查询
    // 下次只看到剩下的一半。
    expect(() => upsertAestheticScores(sqlite, 'silva', [
      { postId: 1, score: 0.25 },
      { postId: 999, score: 0.5 },
    ])).toThrow()
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_aesthetic_scores').get()!.n).toBe(0)
  })
})

describe('waifu 待办查询', () => {
  beforeEach(() => {
    sqlite.exec('DELETE FROM post_waifu_scores')
  })

  it('拼出来的路径是 targetDir + full_path（生成列）', () => {
    insertPost(1, 'png')
    expect(listWaifuPending(sqlite, '/lib')).toEqual([{ postId: 1, path: '/lib/dir/f1.png' }])
  })

  it('只要图片扩展名', () => {
    insertPost(1, 'jpg')
    insertPost(2, 'txt')
    insertPost(3, 'zip')
    insertPost(4, 'WEBP') // 大小写不敏感，和 Python 侧的 LOWER(extension) 一致
    expect(listWaifuPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 4])
  })

  it('已经打过分的不再出现', () => {
    insertPost(1)
    insertPost(2)
    upsertWaifuScores(sqlite, [{ postId: 1, score: 7.5 }])
    expect(listWaifuPending(sqlite, '/lib').map(p => p.postId)).toEqual([2])
  })

  it('被拉黑的不再出现，而且只认 waifu 那个桶', () => {
    insertPost(1)
    insertPost(2)
    recordFailures(sqlite, 'waifu', [{ postId: 2, error: 'unreadable' }])
    recordFailures(sqlite, 'basics', [{ postId: 1, error: '别的 worker' }])
    expect(listWaifuPending(sqlite, '/lib').map(p => p.postId)).toEqual([1])
  })

  it('重复拉黑同一条是空操作而不是唯一约束错误', () => {
    insertPost(1)
    recordFailures(sqlite, 'waifu', [{ postId: 1, error: 'first' }])
    expect(() => recordFailures(sqlite, 'waifu', [{ postId: 1, error: 'again' }])).not.toThrow()
    const rows = sqlite
      .prepare<[], { error: string }>('SELECT error FROM post_process_failures WHERE post_id = 1')
      .all()
    // OR IGNORE：保留第一条，不覆盖
    expect(rows).toEqual([{ error: 'first' }])
  })

  it('limit 截断的是 id 升序的前缀', () => {
    for (const id of [3, 1, 2]) insertPost(id)
    expect(listWaifuPending(sqlite, '/lib', 2).map(p => p.postId)).toEqual([1, 2])
  })

  it('重复写分数是更新', () => {
    insertPost(1)
    upsertWaifuScores(sqlite, [{ postId: 1, score: 7.5 }])
    upsertWaifuScores(sqlite, [{ postId: 1, score: 2.5 }])
    const rows = sqlite.prepare<[], { score: number }>('SELECT score FROM post_waifu_scores WHERE post_id = 1').all()
    expect(rows).toEqual([{ score: 2.5 }])
  })
})
