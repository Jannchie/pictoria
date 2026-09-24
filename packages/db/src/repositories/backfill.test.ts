/**
 * backfill 的待办查询与落库 —— 在一个由真实迁移建出来的临时库上跑。
 *
 * 这两个函数是 §D1 里"所有数据库写入在 TS"的落点，也是唯一会自动写生产库的
 * 新代码路径。它们此前没有任何测试，而"服务跑起来没报错"证明不了待办查询挑对了
 * 东西 —— 生产库上 silva 已经打满，那条路径在真机上根本没被走到过。
 */
import type { TaggerCategories } from '@pictoria/contracts'
import { EMBEDDING_WORKER_KEY } from '@pictoria/contracts'
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
  countBasicsPending,
  countEmbeddingPending,
  countSilvaPending,
  countTaggerPending,
  countWaifuPending,
  fetchEmbeddingBlobs,
  listSilvaPending,
  ensureCanonicalTagGroups,
  listBasicsPending,
  listEmbeddingPending,
  listTaggerPending,
  listWaifuPending,
  persistTaggerResults,
  ratingToInt,
  recordFailures,
  resetScanFloors,
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
  // 水位线是连接级的，清表清不掉它。不清的话上一个用例留下的 `MAX(id)+1`
  // 会让这个用例插进去的低 id 行整批看不见 —— 见 `resetScanFloors` 的注释。
  resetScanFloors(sqlite)
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

  // 水位线在这条查询上比别处松一格：它记的是第一个**候选**，不是第一个 pending。
  // 一个还没有向量的候选是"这一轮算不了"，不是"已经算完了" —— 推过它就等于
  // embedding 补上向量之后 silva 再也不回来看它一眼。
  it('水位线不越过还没有向量的候选', () => {
    insertPost(1)
    insertPost(2)
    sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(2), vectorBlob(2))
    // 1 是候选但没向量，2 有向量 → 这一轮只算得了 2，水位线停在 1
    expect(listSilvaPending(sqlite, 'silva')).toEqual([2])

    sqlite.prepare('INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (2, \'silva\', 0.5)').run()
    sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(1), vectorBlob(1))
    expect(listSilvaPending(sqlite, 'silva')).toEqual([1])
  })

  it('算完的前缀被跳过', () => {
    for (const id of [1, 2, 3]) {
      insertPost(id)
      sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(id), vectorBlob(id))
    }
    expect(listSilvaPending(sqlite, 'silva')).toEqual([1, 2, 3])

    sqlite.prepare('INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (1, \'silva\', 0.5)').run()
    expect(listSilvaPending(sqlite, 'silva')).toEqual([2, 3])
    // 全部算完 → 水位线推到 MAX(id)+1，之后的新 post 照样看得见
    for (const id of [2, 3])
      sqlite.prepare('INSERT INTO post_aesthetic_scores(post_id, scorer, score) VALUES (?, \'silva\', 0.5)').run(id)
    expect(listSilvaPending(sqlite, 'silva')).toEqual([])
    insertPost(4)
    sqlite.prepare('INSERT INTO post_vectors_siglip2(post_id, embedding) VALUES (?, ?)').run(BigInt(4), vectorBlob(4))
    expect(listSilvaPending(sqlite, 'silva')).toEqual([4])
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

/**
 * 一条 tagger 结果。缺省的类别补空数组 —— worker 总是把五个键都回传，而
 * `flattenTaggerTags` 走的是 `Object.entries`，所以形状得是真的。
 */
function taggerRow(
  postId: number,
  tags: Partial<TaggerCategories>,
  rating = '',
): { postId: number, tags: TaggerCategories, rating: string } {
  return {
    postId,
    tags: { general: [], character: [], copyright: [], style: [], meta: [], ...tags },
    rating,
  }
}

const MODEL = 'test-tagger-v1'

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
      taggerRow(1, { general: ['1girl'], character: ['hatsune_miku'] }, 'general'),
    ], g, MODEL)

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
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['1girl'] })], g, MODEL)

    const row = sqlite.prepare<[], { group_id: number }>("SELECT group_id FROM tags WHERE name = '1girl'").get()!
    expect(row.group_id).toBe(g.artist)
  })

  it('rating 只在原值为 0 时写', () => {
    insertPost(1)
    insertPost(2)
    sqlite.prepare('UPDATE posts SET rating = 4 WHERE id = 2').run()
    const g = groups()
    persistTaggerResults(sqlite, [
      taggerRow(1, { general: ['a'] }, 'sensitive'),
      taggerRow(2, { general: ['a'] }, 'general'),
    ], g, MODEL)

    const rows = sqlite.prepare<[], { id: number, rating: number }>('SELECT id, rating FROM posts ORDER BY id').all()
    // 1 从未评级 → 写入 2；2 是人工评的 4 → 不动
    expect(rows).toEqual([{ id: 1, rating: 2 }, { id: 2, rating: 4 }])
  })

  it('rating 字符串认不出来时不写', () => {
    insertPost(1)
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['a'] })], groups(), MODEL)
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
      taggerRow(1, { general: ['1girl'] }),
      taggerRow(2, { general: ['1girl'] }),
    ], g, MODEL)
    expect(shadowed).toEqual([1])
    // post 2 正常拿到自动标签，只剩 1 还在待办里 —— 它被盖了章（所以第一条待办不选它）
    // 但一行 is_auto 都没有（所以第二条选它）。两条待办的分工就在这一句里。
    expect(listTaggerPending(sqlite, '/lib', MODEL).map(p => p.postId)).toEqual([1])
  })

  it('待办查询只看 is_auto = 1', () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('manual')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, 'manual', 0)").run()
    // 只有手工标签 → 仍然是待办
    expect(listTaggerPending(sqlite, '/lib', MODEL).map(p => p.postId)).toEqual([1])

    persistTaggerResults(sqlite, [taggerRow(1, { general: ['auto'] })], groups(), MODEL)
    expect(listTaggerPending(sqlite, '/lib', MODEL)).toEqual([])
  })

  it('整批的标签只 upsert 一次，共享的标签不重复', () => {
    insertPost(1)
    insertPost(2)
    persistTaggerResults(sqlite, [
      taggerRow(1, { general: ['shared', 'a'] }),
      taggerRow(2, { general: ['shared', 'b'] }),
    ], groups(), MODEL)
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM tags').get()!.n).toBe(3)
    expect(sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM post_has_tag').get()!.n).toBe(4)
  })

  it('五个类别各落各的组，style 落 artist', () => {
    insertPost(1)
    const g = groups()
    persistTaggerResults(sqlite, [taggerRow(1, {
      general: ['1girl'],
      character: ['hatsune_miku'],
      copyright: ['vocaloid'],
      style: ['some_artist'],
      meta: ['highres'],
    })], g, MODEL)

    const rows = sqlite
      .prepare<[], { name: string, group_id: number }>('SELECT name, group_id FROM tags ORDER BY name')
      .all()
    expect(rows).toEqual([
      { name: '1girl', group_id: g.general },
      { name: 'hatsune_miku', group_id: g.character },
      { name: 'highres', group_id: g.meta },
      { name: 'some_artist', group_id: g.artist },
      { name: 'vocaloid', group_id: g.copyright },
    ])
  })

  // 换模型重打的**核心**行为。并集会让 WD 打的旧标签永远留着，而"重打"要的正是它们消失。
  it('重打是替换而不是并集：旧的自动标签被删掉', () => {
    insertPost(1)
    const g = groups()
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['old_tag', 'kept_tag'] })], g, 'old-model')
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['kept_tag', 'new_tag'] })], g, MODEL)

    const names = sqlite
      .prepare<[], { tag_name: string }>('SELECT tag_name FROM post_has_tag WHERE post_id = 1 ORDER BY tag_name')
      .all()
      .map(r => r.tag_name)
    expect(names).toEqual(['kept_tag', 'new_tag'])
    // tags 行本身留着（别的图可能还在用），post_count 由触发器跟着掉到 0
    expect(sqlite.prepare<[], { post_count: number }>("SELECT post_count FROM tags WHERE name = 'old_tag'").get())
      .toEqual({ post_count: 0 })
  })

  it('重打不碰手工标签', () => {
    insertPost(1)
    const g = groups()
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('by_hand')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, 'by_hand', 0)").run()
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['auto'] })], g, MODEL)
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['auto2'] })], g, MODEL)

    const rows = sqlite
      .prepare<[], { tag_name: string, is_auto: number }>(
        'SELECT tag_name, is_auto FROM post_has_tag WHERE post_id = 1 ORDER BY tag_name',
      )
      .all()
    expect(rows).toEqual([{ tag_name: 'auto2', is_auto: 1 }, { tag_name: 'by_hand', is_auto: 0 }])
  })

  // 换模型 = 整库重排队。存量行的 `tagger` 是 NULL，而 `NULL <> 'x'` 在 SQLite 里是
  // NULL 不是真 —— 这一条钉住的就是"必须用 IS NOT"，写错了表现是重打静默地什么也不做。
  it('换模型让已打过标的老图重新变成待办（tagger IS NULL 也算）', () => {
    insertPost(1)
    insertPost(2)
    const g = groups()
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['a'] })], g, 'old-model')
    // post 2 模拟存量行：有自动标签，但 tagger 是 NULL
    sqlite.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT DO NOTHING').run('a')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (2, 'a', 1)").run()

    expect(listTaggerPending(sqlite, '/lib', MODEL, undefined, { force: true }).map(p => p.postId))
      .toEqual([1, 2])
    // 换成当前模型之后就都不是待办了
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['a'] }), taggerRow(2, { general: ['a'] })], g, MODEL)
    expect(listTaggerPending(sqlite, '/lib', MODEL, undefined, { force: true })).toEqual([])
  })

  it('被遮住的 post 也盖章，于是只靠黑名单之外还有第二道防线', () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('1girl')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, '1girl', 0)").run()
    persistTaggerResults(sqlite, [taggerRow(1, { general: ['1girl'] })], groups(), MODEL)
    expect(sqlite.prepare<[], { tagger: string | null }>('SELECT tagger FROM posts WHERE id = 1').get())
      .toEqual({ tagger: MODEL })
  })

  it('未知类别抛，而不是把标签写成无组', () => {
    insertPost(1)
    const g = groups()
    expect(() => persistTaggerResults(sqlite, [
      { postId: 1, tags: { future: ['x'] } as unknown as TaggerCategories, rating: '' },
    ], g, MODEL)).toThrow(/unknown tag category/)
  })

  it('空列表是空操作', () => {
    expect(persistTaggerResults(sqlite, [], groups(), MODEL)).toEqual([])
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

// 这条循环的两次全扫要 401 ms（真实库实测），每一批都付一次。vec0 是虚表，
// `NOT EXISTS (SELECT 1 FROM vec WHERE post_id = p.id)` 不走 rowid 点查而是每行全扫
// 一遍虚表（实测 7,335 ms，反而慢 18 倍），所以只能靠把扫描范围压到库尾来省。
describe('embedding 待办扫描的水位线', () => {
  it('待办清空后重复调用直接短路', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    // 水位线已推到 MAX(id)+1。把向量删掉但不动 posts —— post 1 的 id 在水位线
    // **以下**，扫描根本不会走到它。这正是那段 ⚠️ 说的缺口：让老 post 重新变成
    // 待办的写路径必须自己调 wakeAllBackfills()，否则它永远不再被碰。
    sqlite.exec('DELETE FROM post_vectors_siglip2')
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    resetScanFloors(sqlite)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1])
  })

  it('新 post 的 id 在水位线之上，照样扫得出来', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    insertPost(2)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([2])
  })

  it('水位线停在第一个待办上，不越过它', () => {
    insertPost(1)
    insertPost(2)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2])
    // 什么都没算完，所以水位线还压在 1 上 —— 两条都得再扫出来。
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2])
  })

  it('算完的前缀被跳过，剩下的照常扫出来', () => {
    insertPost(1)
    insertPost(2)
    insertPost(3)
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([1, 2, 3])

    // 只算完 1。水位线该推到 2，而 3 不能被带过去。
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([2, 3])
    upsertVectors(sqlite, [{ postId: 2, embedding: vectorBlob(2) }])
    expect(listEmbeddingPending(sqlite, '/lib').map(p => p.postId)).toEqual([3])
  })

  it('force 把水位线清零，重新看得见老 post', () => {
    insertPost(1)
    upsertVectors(sqlite, [{ postId: 1, embedding: vectorBlob(1) }])
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])

    sqlite.exec('DELETE FROM post_vectors_siglip2')
    expect(listEmbeddingPending(sqlite, '/lib')).toEqual([])
    expect(listEmbeddingPending(sqlite, '/lib', undefined, { force: true }).map(p => p.postId)).toEqual([1])
  })
})

// 四条"查 posts 单行状态"的待办查询共用同一条水位线规则（第一个待办 / MAX(id)+1）。
// silva 是例外，它的水位线记的是第一个候选，单独在上面测。
describe('待办水位线（waifu / tagger / basics）', () => {
  /** 让 post 在这个 worker 眼里变成"已算完"。 */
  const complete: Record<string, (id: number) => void> = {
    waifu: id => sqlite.prepare('INSERT INTO post_waifu_scores(post_id, score) VALUES (?, 0.5)').run(id) as never,
    tagger: (id) => {
      sqlite.prepare('INSERT INTO tag_groups(name, color) VALUES (?, ?) ON CONFLICT DO NOTHING').run('general', '#000000')
      sqlite.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT DO NOTHING').run(`t${id}`)
      sqlite.prepare('INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, 1)').run(id, `t${id}`)
      // 两条待办都要消掉，不然"算完了"只满足了一半。
      sqlite.prepare('UPDATE posts SET tagger = ? WHERE id = ?').run(MODEL, id)
    },
    basics: id => sqlite
      .prepare('UPDATE posts SET sha256 = ?, arthash = ?, dominant_color = vec_f32(?) WHERE id = ?')
      .run(`h${id}`, `a${id}`, '[0.1,0.2,0.3]', id) as never,
  }
  const list: Record<string, () => number[]> = {
    waifu: () => listWaifuPending(sqlite, '/lib').map(p => p.postId),
    tagger: () => listTaggerPending(sqlite, '/lib', MODEL).map(p => p.postId),
    basics: () => listBasicsPending(sqlite, '/lib').map(p => p.postId),
  }

  for (const worker of ['waifu', 'tagger', 'basics']) {
    it(`${worker}：算完的前缀被跳过，新 post 照样看得见`, () => {
      for (const id of [1, 2, 3]) insertPost(id)
      expect(list[worker]!()).toEqual([1, 2, 3])

      complete[worker]!(1)
      expect(list[worker]!()).toEqual([2, 3])
      complete[worker]!(2)
      complete[worker]!(3)
      expect(list[worker]!()).toEqual([])

      // 水位线在 MAX(id)+1 上，新 post 的 id 更大 —— 不需要 force 就扫得到
      insertPost(4)
      expect(list[worker]!()).toEqual([4])
    })

    it(`${worker}：水位线以下重新变成待办的行要靠 force 才看得见`, () => {
      insertPost(1)
      complete[worker]!(1)
      expect(list[worker]!()).toEqual([])

      // 手工撤销"已算完"：id 在水位线以下，扫描走不到它
      if (worker === 'waifu')
        sqlite.exec('DELETE FROM post_waifu_scores')
      else if (worker === 'tagger')
        sqlite.exec('DELETE FROM post_has_tag')  // tagger 章还盖着，靠第二条待办选出来
      else
        sqlite.prepare('UPDATE posts SET sha256 = ?, arthash = NULL, dominant_color = NULL').run('')
      expect(list[worker]!()).toEqual([])

      const forced = worker === 'waifu'
        ? listWaifuPending(sqlite, '/lib', undefined, { force: true })
        : worker === 'tagger'
          ? listTaggerPending(sqlite, '/lib', MODEL, undefined, { force: true })
          : listBasicsPending(sqlite, '/lib', undefined, { force: true })
      expect(forced.map(p => p.postId)).toEqual([1])
    })
  }
})

describe('待办计数', () => {
  const MODEL = 'model-under-test'

  /** 1..6 六张图：2、4 有向量；3 被 embedding 拉黑；5 已打 waifu 分；6 是 .txt。 */
  function seed(): void {
    for (const id of [1, 2, 3, 4, 5]) insertPost(id)
    insertPost(6, 'txt')
    upsertVectors(sqlite, [{ postId: 2, embedding: vectorBlob(2) }, { postId: 4, embedding: vectorBlob(4) }])
    recordFailures(sqlite, EMBEDDING_WORKER_KEY, [{ postId: 3, error: 'x' }])
    upsertWaifuScores(sqlite, [{ postId: 5, score: 5 }])
    upsertAestheticScores(sqlite, 'silva', [{ postId: 4, score: 0.5 }])
  }

  const sum = (chunks: Iterable<number>) => [...chunks].reduce((a, b) => a + b, 0)

  const cases: Array<[string, (chunkRows?: number) => Iterable<number>, () => number]> = [
    ['waifu', r => countWaifuPending(sqlite, r), () => listWaifuPending(sqlite, '/lib').length],
    ['tagger', r => countTaggerPending(sqlite, MODEL, r), () => listTaggerPending(sqlite, '/lib', MODEL).length],
    ['basics', r => countBasicsPending(sqlite, r), () => listBasicsPending(sqlite, '/lib').length],
    ['embedding', r => countEmbeddingPending(sqlite, r), () => listEmbeddingPending(sqlite, '/lib').length],
    ['silva', r => countSilvaPending(sqlite, 'silva', r), () => listSilvaPending(sqlite, 'silva').length],
  ]

  for (const [name, count, list] of cases) {
    it(`${name}：计数等于不限量的待办查询条数，扫描前后都是`, () => {
      seed()
      const before = sum(count())
      expect(before).toBeGreaterThan(0)
      expect(before).toBe(list())
      // 扫描推进了水位线，计数跟着从新水位往上数，结果不变
      expect(sum(count())).toBe(before)
    })

    it(`${name}：分块数，各块之和等于一次数完`, () => {
      seed()
      const whole = sum(count())
      for (const rows of [1, 2, 5])
        expect(sum(count(rows))).toBe(whole)
    })

    it(`${name}：计数不推动水位线`, () => {
      seed()
      const expected = list()
      // 计数只读水位线：连数两次之后，扫描看到的还是同一批
      sum(count())
      sum(count(1))
      expect(list()).toBe(expected)
    })
  }

  it('空库全是 0', () => {
    for (const [, count] of cases) expect(sum(count())).toBe(0)
  })

  it('具体数值：embedding 不算被拉黑的和非图片，silva 只算有向量且没分的', () => {
    seed()
    expect(sum(countEmbeddingPending(sqlite))).toBe(2) // 1、5
    expect(sum(countSilvaPending(sqlite, 'silva'))).toBe(1) // 2
    expect(sum(countWaifuPending(sqlite))).toBe(4) // 1..4
  })

  it('分块从水位线开始，水位线以下不产生块', () => {
    for (const id of [1, 2, 3, 4, 5, 6]) insertPost(id)
    upsertWaifuScores(sqlite, [1, 2, 3, 4].map(postId => ({ postId, score: 5 })))
    listWaifuPending(sqlite, '/lib') // 水位线落在第一个待办 5 上
    expect([...countWaifuPending(sqlite, 1)]).toEqual([1, 1])
  })
})
