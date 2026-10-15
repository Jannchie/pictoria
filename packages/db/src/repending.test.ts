/**
 * 「老 post 重新变成待办」的信号由 repository 写函数自己发出（`repending.ts`）。
 *
 * 漏发一次的表现是完全静默的 —— 那张图的 id 在水位线以下，backfill 永远不再碰它 ——
 * 所以每一类这样的写操作在这里都有一条"发了"的断言，以及至少一条"不该发时不发"的
 * 断言（多发不出错，但会逼对应循环全库重扫一轮：tagger 在真实库上是 1.8 秒的同步阻塞）。
 *
 * 加新的重新待办写点时，在这里补一条。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TaggerCategories } from '@pictoria/contracts'
import { MIGRATIONS_DIR, runMigrations } from './migrate.js'
import { notifyRepending, onRepending } from './repending.js'
import { ensureCanonicalTagGroups, listTaggerPending, persistTaggerResults, resetScanFloors } from './repositories/backfill.js'
import { updateForRotate } from './repositories/posts.js'
import { addTagToPost, deleteTag, deleteTags, removeTagFromPost } from './repositories/tags.js'
import type { BackfillWorker } from './workers.js'
import { BACKFILL_WORKERS, failureKey } from './workers.js'

const MODEL = 'test-model'

let sqlite: Database.Database
let tmpDir: string
/** 这个用例里收到的信号，按到达顺序。 */
let heard: BackfillWorker[][]
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

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-repending-'))
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
  for (const t of ['post_process_failures', 'post_has_tag', 'tags', 'posts'])
    sqlite.exec(`DELETE FROM ${t}`)
  resetScanFloors(sqlite)
  heard = []
  unsubscribe = onRepending(sqlite, ws => heard.push([...ws]))
})

afterEach(() => unsubscribe())

describe('通知机制本身', () => {
  it('按连接派发：别的连接上的写不会叫醒这条连接的订阅者', () => {
    const other = new Database(':memory:')
    notifyRepending(other, 'tagger')
    other.close()
    expect(heard).toEqual([])
    notifyRepending(sqlite, 'basics', 'tagger')
    expect(heard).toEqual([['basics', 'tagger']])
  })

  it('取消订阅之后收不到；不点名是空操作', () => {
    unsubscribe()
    notifyRepending(sqlite, 'tagger')
    expect(heard).toEqual([])
    unsubscribe = onRepending(sqlite, ws => heard.push([...ws]))
    notifyRepending(sqlite)
    expect(heard).toEqual([])
  })
})

describe('摘标签 → tagger', () => {
  it('摘掉最后一个自动标签：发，而且那张图确实只有强制重扫才找得到', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    sqlite.prepare('UPDATE posts SET tagger = ?').run(MODEL)
    // 水位线推过 post 1（它此刻不是待办）
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])

    expect(removeTagFromPost(sqlite, 1, 'auto_a')).toBe(true)
    expect(heard).toEqual([['tagger']])
    // 这就是信号存在的理由：不强制重扫就看不见它
    expect(listTaggerPending(sqlite, MODEL)).toEqual([])
    expect(listTaggerPending(sqlite, MODEL, undefined, { force: true }).map(p => p.postId)).toEqual([1])
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

describe('删 tag（FK 级联）→ tagger', () => {
  it('级联剥掉某张图最后一个自动标签：deleteTag 发', () => {
    insertPost(1)
    link(1, 'auto_a', 1)
    deleteTag(sqlite, 'auto_a')
    expect(heard).toEqual([['tagger']])
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
  function shadowedPost(): void {
    insertPost(1)
    link(1, '1girl', 0)
  }

  it('repend（单张重打标）：不拉黑、发信号', () => {
    shadowedPost()
    const shadowed = persistTaggerResults(sqlite, [taggerRow(1, ['1girl'])], ensureCanonicalTagGroups(sqlite), MODEL, { onShadowed: 'repend' })
    expect(shadowed).toEqual([1])
    expect(heard).toEqual([['tagger']])
    expect(sqlite.prepare('SELECT COUNT(*) FROM post_process_failures').pluck().get()).toBe(0)
  })

  it('blacklist（backfill）：当场拉黑进 tagger 的桶、不发信号', () => {
    shadowedPost()
    const shadowed = persistTaggerResults(sqlite, [taggerRow(1, ['1girl'])], ensureCanonicalTagGroups(sqlite), MODEL, { onShadowed: 'blacklist' })
    expect(shadowed).toEqual([1])
    expect(heard).toEqual([])
    expect(sqlite.prepare('SELECT post_id, worker FROM post_process_failures').all())
      .toEqual([{ post_id: 1, worker: failureKey('tagger') }])
  })

  it('没有被遮住的：两种模式都不发', () => {
    insertPost(1)
    persistTaggerResults(sqlite, [taggerRow(1, ['auto'])], ensureCanonicalTagGroups(sqlite), MODEL, { onShadowed: 'repend' })
    expect(heard).toEqual([])
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
