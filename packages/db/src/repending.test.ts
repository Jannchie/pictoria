/**
 * 「老 post 重新变成待办」的信号由 repository 写函数自己发出（`repending.ts`）。
 *
 * 漏发一次的表现是完全静默的 —— 那张图的 id 在水位线以下，backfill 永远不再碰它 ——
 * 所以每一类这样的写操作在这里都有一条"发了"的断言，以及至少一条"不该发时不发"的
 * 断言（多发不出错，但会让对应循环白扫一轮；不带 id 的还会逼它全库重扫：tagger 在真实库上
 * 是 1.8 秒的同步阻塞）。
 *
 * 加新的重新待办写点时，在这里补一条。
 */
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TaggerCategories } from '@pictoria/contracts'
import { notifyRepending, onRepending } from './repending.js'
import { ensureCanonicalTagGroups, listTaggerPending, listWaifuPending, persistTaggerResults, resetScanFloors } from './repositories/backfill.js'
import { persistPostsWithTags } from './repositories/import-persist.js'
import { createPost, insertPostTriples, updateForRotate } from './repositories/posts.js'
import { addTagToPost, deleteTag, deleteTags, removeTagFromPost, setTagSource } from './repositories/tags.js'
import type { BackfillWorker } from './workers.js'
import { BACKFILL_WORKERS, failureKey } from './workers.js'
import { createTestDb } from './testing.js'

const MODEL = 'test-model'

let sqlite: Database.Database
/** 这个用例里收到的信号，按到达顺序。`'*'` 结尾 = 要求强制全扫（没带 id）。 */
let heard: string[][]
let unsubscribe: () => void

function insertPost(id: number): void {
  sqlite
    .prepare('INSERT INTO posts (id, file_path, file_name, extension) VALUES (?, ?, ?, ?)')
    .run(id, 'dir', `f${id}`, 'jpg')
}

function link(postId: number, tag: string, isAuto: 0 | 1): void {
  sqlite.prepare('INSERT INTO tags(name) VALUES (?) ON CONFLICT DO NOTHING').run(tag)
  sqlite.prepare('INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (?, ?, ?)').run(postId, tag, isAuto)
}

function taggerRow(postId: number, general: string[]) {
  return {
    postId,
    tags: { general, character: [], copyright: [], style: [], meta: [] } satisfies TaggerCategories,
    rating: '',
  }
}

/** 订阅者：记下被点名的 worker，强制全扫的信号在末尾多记一个 `'*'`。 */
function listen(): () => void {
  return onRepending(sqlite, (ws, { force }) => heard.push(force ? [...ws, '*'] : [...ws]))
}

beforeAll(() => {
  sqlite = createTestDb()
})

afterAll(() => {
  sqlite.close()
})

beforeEach(() => {
  for (const t of ['post_process_failures', 'post_has_tag', 'tags', 'posts'])
    sqlite.exec(`DELETE FROM ${t}`)
  resetScanFloors(sqlite)
  heard = []
  unsubscribe = listen()
})

afterEach(() => unsubscribe())

describe('通知机制本身', () => {
  it('按连接派发：别的连接上的写不会叫醒这条连接的订阅者', () => {
    const other = new Database(':memory:')
    notifyRepending(other, 'tagger')
    other.close()
    expect(heard).toEqual([])
    notifyRepending(sqlite, ['basics', 'tagger'])
    expect(heard).toEqual([['basics', 'tagger', '*']])
  })

  it('取消订阅之后收不到；不点名是空操作', () => {
    unsubscribe()
    notifyRepending(sqlite, 'tagger')
    expect(heard).toEqual([])
    unsubscribe = listen()
    notifyRepending(sqlite, [])
    expect(heard).toEqual([])
  })

  it('带 id：当场把被点名循环的水位线退到那里，不要求强制全扫；没点名的不动', () => {
    for (const id of [1, 2, 3]) insertPost(id)
    // 两条循环的水位线都推到 MAX(id)+1
    expect(listWaifuPending(sqlite).map(p => p.postId)).toEqual([1, 2, 3])
    sqlite.prepare('INSERT INTO post_waifu_scores (post_id, score) VALUES (1, 1), (2, 1), (3, 1)').run()
    expect(listWaifuPending(sqlite)).toEqual([])
    link(1, 'a', 1)
    link(2, 'a', 1)
    link(3, 'a', 1)
    sqlite.prepare('UPDATE posts SET tagger = ?').run(MODEL)
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])

    sqlite.prepare('DELETE FROM post_waifu_scores WHERE post_id >= 2').run()
    sqlite.prepare('DELETE FROM post_has_tag WHERE post_id >= 2').run()
    notifyRepending(sqlite, 'waifu', 2)
    expect(heard).toEqual([['waifu']])
    expect(listWaifuPending(sqlite).map(p => p.postId)).toEqual([2, 3])
    // tagger 没被点名：水位线没退，不强制就看不见
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])
  })
})

describe('摘标签 → tagger', () => {
  it('摘掉最后一个自动标签：发，水位线退到那张图，不强制也找得到', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    sqlite.prepare('UPDATE posts SET tagger = ?').run(MODEL)
    // 水位线推过 post 1（它此刻不是待办）
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])

    expect(removeTagFromPost(sqlite, 1, 'auto_a')).toBe(true)
    expect(heard).toEqual([['tagger']])
    // 这就是信号存在的理由：没有它，post 1 在水位线以下，不强制重扫就看不见
    expect(listTaggerPending(sqlite, MODEL).map(p => p.postId)).toEqual([1])
  })

  it('还剩别的自动标签、或者摘的是手工标签：不发', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    link(1, 'auto_b', 1)
    link(1, 'manual', 0)
    expect(removeTagFromPost(sqlite, 1, 'auto_a')).toBe(true)
    expect(removeTagFromPost(sqlite, 1, 'manual')).toBe(true)
    expect(heard).toEqual([])
  })

  it('本来就没有这个标签：不发', () => {
    insertPost(1)
    expect(removeTagFromPost(sqlite, 1, 'nope')).toBe(false)
    expect(addTagToPost(sqlite, 1, 'manual')).toBe(true)
    expect(heard).toEqual([])
  })
})

describe('确认自动标签为人工 → tagger', () => {
  it('确认掉最后一个自动标签：发，水位线退到那张图', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    sqlite.prepare('UPDATE posts SET tagger = ?').run(MODEL)
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])

    expect(setTagSource(sqlite, 1, 'auto_a', false)).toBe(true)
    expect(heard).toEqual([['tagger']])
    expect(listTaggerPending(sqlite, MODEL).map(p => p.postId)).toEqual([1])
  })

  it('还剩别的自动标签、已是人工、改回自动、不在 post 上：不发', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    link(1, 'auto_b', 1)
    link(1, 'manual', 0)
    expect(setTagSource(sqlite, 1, 'auto_a', false)).toBe(true)
    expect(setTagSource(sqlite, 1, 'manual', false)).toBe(true)
    expect(setTagSource(sqlite, 1, 'manual', true)).toBe(true)
    expect(setTagSource(sqlite, 1, 'nope', false)).toBe(false)
    expect(heard).toEqual([])
    const rows = sqlite.prepare('SELECT tag_name, is_auto FROM post_has_tag ORDER BY tag_name').all()
    expect(rows).toEqual([
      { tag_name: 'auto_a', is_auto: 0 },
      { tag_name: 'auto_b', is_auto: 1 },
      { tag_name: 'manual', is_auto: 1 },
    ])
  })

  it('确认过的标签挺过重新打标：tagger 只清 is_auto = 1 的行', () => {
    insertPost(1)
    persistTaggerResults(sqlite, [taggerRow(1, ['kept', 'dropped'])], ensureCanonicalTagGroups(sqlite), MODEL)
    setTagSource(sqlite, 1, 'kept', false)
    persistTaggerResults(sqlite, [taggerRow(1, ['fresh'])], ensureCanonicalTagGroups(sqlite), 'next-model')
    const rows = sqlite.prepare('SELECT tag_name, is_auto FROM post_has_tag ORDER BY tag_name').all()
    expect(rows).toEqual([{ tag_name: 'fresh', is_auto: 1 }, { tag_name: 'kept', is_auto: 0 }])
  })
})

describe('删 tag（FK 级联）→ tagger', () => {
  it('级联剥掉某张图最后一个自动标签：deleteTag 发，水位线退到那张图', () => {
    insertPost(1)
    insertPost(2)
    link(1, 'keep', 1)
    link(2, 'auto_a', 1)
    sqlite.prepare('UPDATE posts SET tagger = ?').run(MODEL)
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])
    deleteTag(sqlite, 'auto_a')
    expect(heard).toEqual([['tagger']])
    expect(listTaggerPending(sqlite, MODEL).map(p => p.postId)).toEqual([2])
  })

  it('deleteTags 一次删掉一张图的全部自动标签也算', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    link(1, 'auto_b', 1)
    deleteTags(sqlite, ['auto_a', 'auto_b'])
    expect(heard).toEqual([['tagger']])
  })

  it('只删手工标签、或者每张图都还剩别的自动标签：不发', () => {
    insertPost(1)
    link(1, 'manual', 0)
    link(1, 'auto_a', 1)
    link(1, 'auto_b', 1)
    deleteTags(sqlite, ['manual', 'auto_a'])
    expect(heard).toEqual([])
    expect(sqlite.prepare('SELECT tag_name FROM post_has_tag').pluck().all()).toEqual(['auto_b'])
  })
})

describe('旋转写回空的 arthash / sha256 → basics', () => {
  const ok = { sha256: 'abc', size: 1, width: 2, height: 3, arthash: 'h' }

  it('arthash 写成 NULL：发', () => {
    insertPost(1)
    updateForRotate(sqlite, 1, { ...ok, arthash: null })
    expect(heard).toEqual([['basics']])
  })

  it('sha256 写成空串：发', () => {
    insertPost(1)
    updateForRotate(sqlite, 1, { ...ok, sha256: '' })
    expect(heard).toEqual([['basics']])
  })

  it('全部有值、或者 post 不存在：不发', () => {
    insertPost(1)
    updateForRotate(sqlite, 1, ok)
    updateForRotate(sqlite, 999, { ...ok, arthash: null })
    expect(heard).toEqual([])
  })
})

describe('tagger 结果被手工标签遮住 → tagger', () => {
  it('发信号、报回被遮住的图，但不拉黑（拉黑是调用方按策略做的）', () => {
    insertPost(1)
    link(1, '1girl', 0)
    const shadowed = persistTaggerResults(sqlite, [taggerRow(1, ['1girl'])], ensureCanonicalTagGroups(sqlite), MODEL)
    expect(shadowed.map(f => f.postId)).toEqual([1])
    expect(heard).toEqual([['tagger']])
    expect(sqlite.prepare('SELECT COUNT(*) FROM post_process_failures').pluck().get()).toBe(0)
  })

  it('没有被遮住的：不发', () => {
    insertPost(1)
    persistTaggerResults(sqlite, [taggerRow(1, ['auto'])], ensureCanonicalTagGroups(sqlite), MODEL)
    expect(heard).toEqual([])
  })
})

describe('新建 post → 全部 worker（只叫醒，不强制全扫）', () => {
  const all = [...BACKFILL_WORKERS]

  it('createPost', () => {
    createPost(sqlite, { filePath: 'dir', fileName: 'new', extension: 'jpg' })
    expect(heard).toEqual([all])
  })

  it('insertPostTriples：一批一次；空批不发', () => {
    insertPostTriples(sqlite, [])
    expect(heard).toEqual([])
    insertPostTriples(sqlite, [['dir', 'a', 'jpg'], ['dir', 'b', 'jpg']])
    expect(heard).toEqual([all])
  })

  it('persistPostsWithTags：一批一次；空批不发', () => {
    persistPostsWithTags(sqlite, [])
    expect(heard).toEqual([])
    persistPostsWithTags(sqlite, [{ filePath: 'dir', fileName: 'a', extension: 'jpg', source: '', rating: 0, publishedAt: null, tags: {} }])
    expect(heard).toEqual([all])
  })

  it('新行在水位线之上：不需要强制就扫得到', () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO post_waifu_scores (post_id, score) VALUES (1, 1)').run()
    expect(listWaifuPending(sqlite)).toEqual([])
    const id = createPost(sqlite, { filePath: 'dir', fileName: 'new', extension: 'jpg' })
    expect(listWaifuPending(sqlite).map(p => p.postId)).toEqual([id])
  })
})

describe('worker 身份', () => {
  // 这些值已经写在真实库的 post_process_failures 里，改一个字那个 worker 的黑名单
  // 就静默失效。钉死。
  it('黑名单桶名逐字不变', () => {
    expect(Object.fromEntries(BACKFILL_WORKERS.map(w => [w, failureKey(w)]))).toEqual({
      basics: 'basics',
      silva: 'aesthetic:silva',
      silva_luna: 'aesthetic:silva_luna',
      waifu: 'waifu',
      tagger: 'tagger',
      embedding: 'embedding:siglip2',
    })
  })

  it('启动顺序：basics 最前，silva 家族按 SCORERS', () => {
    expect(BACKFILL_WORKERS).toEqual(['basics', 'silva', 'silva_luna', 'waifu', 'tagger', 'embedding'])
  })
})
