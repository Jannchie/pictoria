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
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'
import {
  aestheticWorkerKey,
  CANONICAL_TAG_GROUPS,
  fetchEmbeddingBlobs,
  listSilvaPending,
  ensureCanonicalTagGroups,
  listEmbeddingPending,
  listTaggerPending,
  listWaifuPending,
  persistTaggerResults,
  ratingToInt,
  recordFailures,
  resetEmbeddingScanMemo,
  upsertAestheticScores,
  upsertVectors,
  upsertWaifuScores,
} from './backfill.js'

const here = path.dirname(fileURLToPath(import.meta.url))


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
  runMigrations(sqlite, MIGRATIONS_DIR)
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

describe('tagger 落库', () => {
  beforeEach(() => {
    for (const t of ['post_has_tag', 'tags', 'tag_groups']) sqlite.exec(`DELETE FROM ${t}`)
  })

  function groups() {
    return ensureCanonicalTagGroups(sqlite)
  }

  // 断言**键序**而不是集合：顺序即优先级，一个标签同时出现在多个 `tag_string_*` 里
  // 时先列的组赢（worker 侧 `_build_tag_to_group` 的 `setdefault` 靠的就是这个）。
  // 顺带也就把"五个都在"钉住了 —— `meta` 少一个都不行，导入器只读这张表里有的类别，
  // 缺了就静默丢掉 highres / commentary 那一类标签。
  it('五个规范组按优先级序幂等创建', () => {
    const first = groups()
    expect(groups()).toEqual(first)
    expect(Object.keys(first)).toEqual([...CANONICAL_TAG_GROUPS])
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tag_groups').get()!.n)
      .toBe(CANONICAL_TAG_GROUPS.length)
  })

  // 颜色本身不重要，"每个组都有颜色"重要 —— 前端拿它画 tag 徽章，NULL 会渲染成透明。
  it('每个规范组都有颜色', () => {
    groups()
    const rows = sqlite
      .prepare<[], { name: string, color: string | null }>('SELECT name, color FROM tag_groups')
      .all()
    expect(rows.filter(r => r.color === null)).toEqual([])
  })

  it('general 与 character 落到各自的组', () => {
    insertPost(1)
    const g = groups()
    persistTaggerResults(sqlite, [
      { postId: 1, generalTags: ['1girl'], characterTags: ['hatsune_miku'], rating: 'general' },
    ], g)

    const rows = sqlite
      .prepare<[], { name: string, group_id: number }>('SELECT name, group_id FROM tags ORDER BY name')
      .all()
    expect(rows).toEqual([
      { name: '1girl', group_id: g.general },
      { name: 'hatsune_miku', group_id: g.character },
    ])
  })

  it('已经归过组的标签不被模型的猜测改组', () => {
    insertPost(1)
    const g = groups()
    // 手工把 1girl 归进 artist 组（人为的，但足以说明规则）
    sqlite.prepare('INSERT INTO tags(name, group_id) VALUES (?, ?)').run('1girl', g.artist)
    persistTaggerResults(sqlite, [{ postId: 1, generalTags: ['1girl'], characterTags: [], rating: '' }], g)

    const row = sqlite.prepare<[], { group_id: number }>("SELECT group_id FROM tags WHERE name = '1girl'").get()!
    expect(row.group_id).toBe(g.artist)
  })

  it('rating 只在原值为 0 时写', () => {
    insertPost(1)
    insertPost(2)
    sqlite.prepare('UPDATE posts SET rating = 4 WHERE id = 2').run()
    const g = groups()
    persistTaggerResults(sqlite, [
      { postId: 1, generalTags: ['a'], characterTags: [], rating: 'sensitive' },
      { postId: 2, generalTags: ['a'], characterTags: [], rating: 'general' },
    ], g)

    const rows = sqlite.prepare<[], { id: number, rating: number }>('SELECT id, rating FROM posts ORDER BY id').all()
    // 1 从未评级 → 写入 2；2 是人工评的 4 → 不动
    expect(rows).toEqual([{ id: 1, rating: 2 }, { id: 2, rating: 4 }])
  })

  it('rating 字符串认不出来时不写', () => {
    insertPost(1)
    persistTaggerResults(sqlite, [{ postId: 1, generalTags: ['a'], characterTags: [], rating: '' }], groups())
    expect(sqlite.prepare<[], { rating: number }>('SELECT rating FROM posts WHERE id = 1').get()!.rating).toBe(0)
    expect(ratingToInt('bogus')).toBe(0)
  })

  it('标签全部被手工标签遮住的 post 被报回来', () => {
    insertPost(1)
    insertPost(2)
    const g = groups()
    // post 1 已经手工打了同一个标签 → 自动行插不进去
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('1girl')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, '1girl', 0)").run()

    const shadowed = persistTaggerResults(sqlite, [
      { postId: 1, generalTags: ['1girl'], characterTags: [], rating: '' },
      { postId: 2, generalTags: ['1girl'], characterTags: [], rating: '' },
    ], g)
    expect(shadowed).toEqual([1])
    // post 2 正常拿到自动标签，只剩 1 还在待办里
    expect(listTaggerPending(sqlite, '/lib').map(p => p.postId)).toEqual([1])
  })

  it('待办查询只看 is_auto = 1', () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('manual')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, 'manual', 0)").run()
    // 只有手工标签 → 仍然是待办
    expect(listTaggerPending(sqlite, '/lib').map(p => p.postId)).toEqual([1])

    persistTaggerResults(sqlite, [{ postId: 1, generalTags: ['auto'], characterTags: [], rating: '' }], groups())
    expect(listTaggerPending(sqlite, '/lib')).toEqual([])
  })

  it('整批的标签只 upsert 一次，共享的标签不重复', () => {
    insertPost(1)
    insertPost(2)
    persistTaggerResults(sqlite, [
      { postId: 1, generalTags: ['shared', 'a'], characterTags: [], rating: '' },
      { postId: 2, generalTags: ['shared', 'b'], characterTags: [], rating: '' },
    ], groups())
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tags').get()!.n).toBe(3)
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_has_tag').get()!.n).toBe(4)
  })

  it('空列表是空操作', () => {
    expect(persistTaggerResults(sqlite, [], groups())).toEqual([])
  })
})

describe('embedding 向量落库', () => {
  it('post_id 必须能以 BigInt 写进 vec0（JS number 会被拒）', () => {
    insertPost(1)
    const blob = vectorBlob(3)
    // 这条是回归钉：better-sqlite3 把 JS number 按 REAL 绑定，vec0 的主键只收整数，
    // 直接传 number 会报 "Only integers are allowed for primary key values"。
    expect(() => upsertVectors(sqlite, [{ postId: 1, embedding: blob }])).not.toThrow()
    const got = fetchEmbeddingBlobs(sqlite, [1]).get(1)!
    expect(Buffer.compare(got, blob)).toBe(0)
  })

  it('重复写同一个 post 是替换而不是第二行（vec0 没有 ON CONFLICT）', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(2) }])
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_vectors_siglip2').get()!.n).toBe(1)
    expect(Buffer.compare(fetchEmbeddingBlobs(sqlite, [1]).get(1)!, vectorBlob(2))).toBe(0)
  })

  it('写完之后待办查询就不再返回它', () => {
    insertPost(1)
    insertPost(2)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2])
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([2])
  })

  it('待办查询过滤扩展名与黑名单，路径拼法同 waifu', () => {
    insertPost(1, 'png')
    insertPost(2, 'txt')
    insertPost(3)
    recordFailures(sqlite, 'embedding:siglip2', [{ postId: 3, error: 'unreadable' }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([{ postId: 1, path: '/lib/dir/f1.png' }])
  })

  it('空列表是空操作', () => {
    expect(() => upsertVectors(sqlite, [])).not.toThrow()
  })

  // post 已经被删掉了还写向量 = 一条谁也删不掉的孤儿：删除路径按 post id 清 vec0，
  // 而那个 post 已经不在了。生产库上攒出过 67 条（迁移 0015 清的就是它们），来源是
  // 待办查询选中 → 任务算几分钟 → 这期间 sync 把行删了 → 结果回来照写。
  it('不给已经不存在的 post 写向量', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }, { postId: 999, embedding: vectorBlob(2) }])
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_vectors_siglip2').get()!.n).toBe(1)
    expect(fetchEmbeddingBlobs(sqlite, [999]).size).toBe(0)
  })
})

// 这条循环的两次全扫要 401 ms（真实库实测），而它每 30 秒跑一次、库全算完之后也照跑。
// vec0 是虚表，`NOT EXISTS (SELECT 1 FROM vec WHERE post_id = p.id)` 不走 rowid 点查
// 而是每行全扫一遍虚表（实测 7,335 ms，反而慢 18 倍），所以只能靠跳过整轮来省。
describe('embedding 待办扫描的指纹门控', () => {
  beforeEach(() => {
    resetEmbeddingScanMemo(sqlite)
  })

  it('待办清空后重复调用直接短路', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    // 指纹已记下。把向量删掉但不动 posts —— 门控看不到这个变化，仍然短路。
    // 这正是设计意图：待办只会因为**新 post** 而出现，没有别的来源。
    sqlite.exec('DELETE FROM post_vectors_siglip2')
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    resetEmbeddingScanMemo(sqlite)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1])
  })

  it('有新 post 时指纹失效，重新扫出来', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    insertPost(2)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([2])
  })

  it('这一轮有待办就不记指纹（下一轮还得接着扫）', () => {
    insertPost(1)
    insertPost(2)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2])
    // 没有任何东西变，但因为上一轮非空，这一轮照样得跑完整查询
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2])
  })
})
