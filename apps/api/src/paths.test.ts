/**
 * 路径包含判定：`isInside` / `resolveInside` 的逃逸检查，以及图片端点和上传共用的
 * `resolvePublicInside`（库内、且不在 `.pictoria/`）。
 *
 * 每一条反例都是一种真实的绕过写法；`.pictoria/` 里放着两个 sqlite 和会被 gallery-dl
 * 当 `--config` 读的配置，读到或写进去都是事故。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isInside, resolveInside, resolvePublicInside } from './paths.js'

const win = process.platform === 'win32'

let root: string
let pictoria: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-paths-'))
  pictoria = path.join(root, '.pictoria')
  fs.mkdirSync(path.join(pictoria, 'thumbnails'), { recursive: true })
  fs.writeFileSync(path.join(pictoria, 'pictoria.sqlite'), 'x')
  fs.mkdirSync(path.join(root, 'art'), { recursive: true })
  fs.writeFileSync(path.join(root, 'art', 'a.png'), 'x')
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('isInside', () => {
  it('根自身与子路径在内', () => {
    expect(isInside(root, root)).toBe(true)
    expect(isInside(path.join(root, 'a', 'b'), root)).toBe(true)
  })

  it('前缀相同的兄弟目录不在内', () => {
    expect(isInside(`${root}-secret`, root)).toBe(false)
    expect(isInside(path.dirname(root), root)).toBe(false)
  })

  it.runIf(win)('Windows 上不分大小写', () => {
    expect(isInside(path.join(root.toUpperCase(), 'X'), root)).toBe(true)
  })
})

describe('resolveInside', () => {
  it('普通相对路径与前导斜杠', () => {
    expect(resolveInside(root, 'art/a.png')).toBe(path.join(root, 'art', 'a.png'))
    expect(resolveInside(root, '/art/a.png')).toBe(path.join(root, 'art', 'a.png'))
  })

  it('`..` 逃逸 → null', () => {
    expect(resolveInside(root, '../x.png')).toBeNull()
    expect(resolveInside(root, 'art/../../x.png')).toBeNull()
    expect(resolveInside(root, String.raw`art\..\..\x.png`)).toBe(win ? null : path.join(root, String.raw`art\..\..\x.png`))
  })

  it.runIf(win)('另一个盘的绝对路径 → null', () => {
    expect(resolveInside(root, 'C:/Windows/win.ini')).toBeNull()
  })
})

describe('resolvePublicInside', () => {
  const check = (rel: string) => resolvePublicInside(root, pictoria, rel)

  it('库内普通路径放行（含尚不存在的上传目标）', () => {
    expect(check('art/a.png')).toBe(path.join(root, 'art', 'a.png'))
    expect(check('new/dir/b.png')).toBe(path.join(root, 'new', 'dir', 'b.png'))
    // 名字里带 .pictoria 但不是那个目录
    expect(check('art/.pictoria-like/a.png')).not.toBeNull()
    expect(check('art/.pictoria/a.png')).not.toBeNull()
  })

  it('`..` 逃逸、绝对路径 → null', () => {
    expect(check('../x.png')).toBeNull()
    expect(check('art/../../x.png')).toBeNull()
    expect(check(path.join(path.dirname(root), 'x.png'))).toBeNull()
  })

  it('`.pictoria/` 本身与其下任意路径 → null', () => {
    expect(check('.pictoria')).toBeNull()
    expect(check('.pictoria/pictoria.sqlite')).toBeNull()
    expect(check('/.pictoria/pictoria.sqlite')).toBeNull()
    expect(check('.pictoria/thumbnails/art/a.png')).toBeNull()
    expect(check('art/../.pictoria/gallery-dl.conf')).toBeNull()
  })

  it.runIf(win)('大小写、反斜杠、末尾点号 / 空格的别名 → null', () => {
    expect(check('.PICTORIA/pictoria.sqlite')).toBeNull()
    expect(check(String.raw`.pictoria\pictoria.sqlite`)).toBeNull()
    expect(check('.pictoria./pictoria.sqlite')).toBeNull()
    expect(check('.pictoria /gallery-dl.conf')).toBeNull()
    expect(check('.pictoria.../gallery-dl.conf')).toBeNull()
  })

  it('ADS / 盘符 / NUL → null', () => {
    expect(check('art/a.png:secret')).toBeNull()
    expect(check('.pictoria::$INDEX_ALLOCATION/pictoria.sqlite')).toBeNull()
    expect(check('C:/Windows/win.ini')).toBeNull()
    expect(check('art/a\0.png')).toBeNull()
  })

  it('指向 `.pictoria/` 的 junction / symlink → null（真实路径判定）', () => {
    const link = path.join(root, 'alias')
    try {
      fs.symlinkSync(pictoria, link, 'junction')
    }
    catch {
      return // 无权建链接的环境：字符串层面的用例已覆盖其余部分
    }
    try {
      expect(check('alias/pictoria.sqlite')).toBeNull()
      expect(check('alias/new-upload.png')).toBeNull()
    }
    finally {
      // 只拆链接本身，绝不递归（递归会顺着 junction 删掉目标里的东西）。
      try {
        fs.unlinkSync(link)
      }
      catch {
        fs.rmdirSync(link)
      }
    }
  })
})
