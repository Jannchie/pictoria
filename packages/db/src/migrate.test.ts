/**
 * `runMigrations` 的外键检查：留下悬空外键的迁移必须整笔回滚，第二次启动也照样报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from './migrate.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-mig-'))
  fs.writeFileSync(path.join(dir, '0001_parent.sql'), `
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));
  `)
  fs.writeFileSync(path.join(dir, '0002_dangling.sql'), `INSERT INTO child (id, parent_id) VALUES (1, 999);`)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('runMigrations foreign_key_check', () => {
  it('rolls back a migration that leaves dangling foreign keys, and keeps failing on reboot', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    expect(() => runMigrations(db, dir)).toThrow(/dangling foreign keys/)
    // 0001 已提交，0002 整笔回滚：数据和版本行都不在。
    expect(db.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 0 })
    const versions = db.prepare('SELECT version FROM _schema_versions').all() as Array<{ version: string }>
    expect(versions).toHaveLength(1)
    expect(versions[0]!.version.startsWith('0001')).toBe(true)

    // 第二次启动不能静默通过。
    expect(() => runMigrations(db, dir)).toThrow(/dangling foreign keys/)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    db.close()
  })
})
