/**
 * 「未评分画师」代表图：谁算未评分、挑哪张、怎么去重和排序。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, runMigrations } from '../migrate.js'
import { unratedArtistPickIds } from './unrated-artists.js'

let sqlite: Database.Database
let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-unrated-artists-'))
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
  for (const t of ['post_has_tag', 'post_aesthetic_scores', 'posts', 'tags', 'tag_groups']) sqlite.exec(`DELETE FROM ${t}`)
  sqlite.prepare('INSERT INTO tag_groups (id, name) VALUES (1, \'artist\'), (2, \'general\')').run()
})

function post(id: number, { score = 0, silva }: { score?: number, silva?: number } = {}): void {
  sqlite
    .prepare('INSERT INTO posts (id, file_path, file_name, extension, width, height, score) VALUES (?, \'dir\', ?, \'jpg\', 100, 100, ?)')
    .run(id, `f${id}`, score)
  if (silva !== undefined)
    sqlite.prepare('INSERT INTO post_aesthetic_scores (post_id, scorer, score) VALUES (?, \'silva\', ?)').run(id, silva)
}

/** 建标签并挂到这些图上；`post_count` 由 post_has_tag 的触发器维护。 */
function tag(name: string, postIds: number[], groupId = 1): void {
  sqlite.prepare('INSERT OR IGNORE INTO tags (name, group_id) VALUES (?, ?)').run(name, groupId)
  for (const id of postIds)
    sqlite.prepare('INSERT INTO post_has_tag (post_id, tag_name) VALUES (?, ?)').run(id, name)
}

describe('unratedArtistPickIds', () => {
  it('有任何一张图被打过星的画师不算未评分', () => {
    post(1, { silva: 0.5 })
    post(2, { score: 3, silva: 0.1 })
    tag('rated_artist', [1, 2])
    post(3, { silva: 0.4 })
    tag('fresh_artist', [3])
    expect(unratedArtistPickIds(sqlite)).toEqual([3])
  })

  it('占位 artist 标签永远不出现', () => {
    post(1, { silva: 0.9 })
    tag('anonymous_artist', [1])
    post(2, { silva: 0.8 })
    tag('third-party_edit', [2])
    post(3, { silva: 0.1 })
    tag('real_artist', [3])
    expect(unratedArtistPickIds(sqlite)).toEqual([3])
  })

  it('非 artist 组的标签被忽略', () => {
    post(1, { silva: 0.9 })
    tag('1girl', [1], 2)
    expect(unratedArtistPickIds(sqlite)).toEqual([])
  })

  it('代表图挑 SILVA 分最高的，没分的排在有分的后面', () => {
    post(1)
    post(2, { silva: 0.3 })
    post(3, { silva: 0.7 })
    tag('artist_a', [1, 2, 3])
    expect(unratedArtistPickIds(sqlite)).toEqual([3])

    // 全都没分时按 id 取最小的那张
    post(10)
    post(11)
    tag('artist_b', [11, 10])
    expect(unratedArtistPickIds(sqlite)).toEqual([3, 10])
  })

  it('一张图同时是两个未评分画师的代表图时只出现一次', () => {
    post(1, { silva: 0.9 })
    tag('artist_a', [1])
    tag('artist_b', [1])
    expect(unratedArtistPickIds(sqlite)).toEqual([1])
  })

  it('按代表图的 SILVA 分降序，无分垫底，同分按 id 升序', () => {
    post(1)
    tag('a1', [1])
    post(2, { silva: 0.2 })
    tag('a2', [2])
    post(3, { silva: 0.8 })
    tag('a3', [3])
    post(4, { silva: 0.8 })
    tag('a4', [4])
    post(5, { silva: 0.5 })
    tag('a5', [5])
    expect(unratedArtistPickIds(sqlite)).toEqual([3, 4, 5, 2, 1])
  })
})
