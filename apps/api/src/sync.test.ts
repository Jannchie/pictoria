/**
 * 对账的两道删除闸门。
 *
 * 这里守的是整个仓库里**唯一不可逆**的一条路径：`syncMetadata` 判定"磁盘上没有"
 * 之后走 `deletePostFiles`，删的是 DB 行加**原图文件**。而判定依据只是一次目录
 * 遍历的结果，任何让遍历少看见文件的原因（外置盘没挂上、网络盘抖一下、权限变了）
 * 都会一次性把整库判成已删除。
 *
 * 所以三件事必须成立，且必须有测试盯着：
 *
 * 1. 读不动的目录要**记下来**（个数 + 相对路径），不能等价于"这底下没有文件"；
 * 2. 读不动的目录按**子树**豁免删除判定 —— 其余目录照常对账，一个永久读不动的
 *    目录不能把全库的删除对账冻死；
 * 3. 可删的量超过阈值时整体拒绝，除非按次（`allowMassDelete`）或进程级（环境
 *    变量）放行。新增在任何情况下照常。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createDb, MIGRATIONS_DIR, runMigrations } from '@pictoria/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SyncModule = typeof import('./sync.js')

let tmp: string

/**
 * 换一个库根重新加载模块树。
 *
 * `paths.ts` 的 `targetDir()` 是 `once()` 缓存的 —— 首次调用之后再改 env 不生效，
 * 所以每个场景都得连 `paths.js` 一起重新加载。顺带把 `sync.js` 的 mtime 缓存也
 * 清干净，场景之间不会互相看见对方扫过的目录。
 */
async function loadSync(root: string): Promise<SyncModule> {
  vi.resetModules()
  process.env.PICTORIA_TARGET_DIR = root
  return import('./sync.js')
}

/** 一个跑完迁移的空库，外加 `posts` 里的 n 行（文件按需真的建出来）。 */
function makeDb(dbFile: string) {
  const { sqlite } = createDb({ path: dbFile })
  runMigrations(sqlite, MIGRATIONS_DIR)
  return sqlite
}

/**
 * 一个库：`posts` 里 `count` 行，其中前 `onDisk` 个的文件真的在盘上。
 *
 * 差集就是"被判为已删除"的那些 —— 闸门的输入。连接记在 `openDb` 里由 `afterEach`
 * 关掉，断言失败时也不会漏一个句柄（Windows 上漏了就删不掉临时目录）。
 */
function seedLibrary(count: number, onDisk: number): { root: string, sqlite: ReturnType<typeof makeDb> } {
  const root = path.join(tmp, 'lib')
  fs.mkdirSync(root, { recursive: true })
  const sqlite = makeDb(path.join(tmp, 'db.sqlite'))
  openDb = sqlite

  const ins = sqlite.prepare('INSERT INTO posts(file_path, file_name, extension) VALUES (?, ?, ?)')
  sqlite.transaction(() => {
    for (let i = 0; i < count; i++) ins.run('.', `img${i}`, 'jpg')
  })()
  for (let i = 0; i < onDisk; i++)
    fs.writeFileSync(path.join(root, `img${i}.jpg`), 'x')

  return { root, sqlite }
}

function postCount(sqlite: ReturnType<typeof makeDb>): number {
  return sqlite.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM posts').get()!.n
}

const quiet = { info: () => {}, warn: () => {} }

let openDb: ReturnType<typeof makeDb> | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-sync-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  openDb?.close()
  openDb = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.PICTORIA_SYNC_ALLOW_MASS_DELETE
})

/**
 * 让名为 `dirName` 的目录 readdir 失败 —— 制造"不完整扫描"的标准手法。
 *
 * 不用悬空 symlink：它在 readdir 里是 symlink dirent（`isDirectory()` 为 false），
 * `walk` 根本不会去 stat 它，failedDirs 保持为空 —— 造不出不完整；而且 `symlinkSync`
 * 在未开开发者模式的 Windows 上直接 EPERM。mock 是唯一在三个平台上都真实制造出
 * readdir 失败的办法。
 */
function breakDir(dirName: string): void {
  const real = fs.promises.readdir.bind(fs.promises)
  vi.spyOn(fs.promises, 'readdir').mockImplementation((async (p: unknown, o: unknown) => {
    if (path.basename(String(p)) === dirName)
      throw Object.assign(new Error(`EACCES: permission denied, scandir '${String(p)}'`), { code: 'EACCES' })
    return real(p as string, o as never)
  }) as typeof fs.promises.readdir)
}

describe('scanLibrary', () => {
  it('走得通的库根 failedDirs 为空', async () => {
    const root = path.join(tmp, 'lib')
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'a.jpg'), 'x')
    fs.writeFileSync(path.join(root, 'sub', 'b.png'), 'x')

    const { scanLibrary } = await loadSync(root)
    const r = await scanLibrary(root, { log: quiet })
    expect(r.failedDirs).toEqual([])
    expect(r.files).toEqual(expect.arrayContaining([['.', 'a', 'jpg'], ['sub', 'b', 'png']]))
  })

  // 库根根本 stat 不到 —— 盘没挂上就是这个形状。以前这里是 `catch { return }`，
  // 结果和"库是空的"一模一样。
  it('库根读不动时记进 failedDirs，而不是当成空库', async () => {
    const missing = path.join(tmp, 'not-there')
    const { scanLibrary } = await loadSync(missing)
    const r = await scanLibrary(missing, { log: quiet })
    expect(r.failedDirs).toEqual(['.'])
    expect(r.files).toEqual([])
  })
})

describe('syncMetadata 的删除闸门', () => {
  it('库根整个读不动时一行都不删', async () => {
    const { root, sqlite } = seedLibrary(5, 5)
    // 库根整个消失（盘掉了），但 5 个文件在 DB 里都还有行。
    fs.rmSync(root, { recursive: true, force: true })

    const { syncMetadata } = await loadSync(root)
    const r = await syncMetadata(sqlite, { log: quiet })

    expect(r.removed).toBe(0)
    expect(r.skippedDeletes).toBe(5)
    expect(postCount(sqlite)).toBe(5)
  })

  // 一个永久读不动的目录（NAS 的 System Volume Information、ACL 受限的文件夹）
  // 不能把全库的删除对账冻死 —— 它只保护自己子树下的行。
  it('读不动的目录只保护自己的子树，其余目录照常对账', async () => {
    const root = path.join(tmp, 'lib')
    fs.mkdirSync(path.join(root, 'bad'), { recursive: true })
    fs.mkdirSync(path.join(root, 'ok'), { recursive: true })
    const sqlite = makeDb(path.join(tmp, 'db.sqlite'))
    openDb = sqlite
    const ins = sqlite.prepare('INSERT INTO posts(file_path, file_name, extension) VALUES (?, ?, ?)')
    for (const [dir, name] of [['bad', 'b0'], ['bad', 'b1'], ['ok', 'k0'], ['ok', 'k1']] as const)
      ins.run(dir, name, 'jpg')
    // bad/ 下的两个文件其实都在，但目录读不动，扫描看不见它们；
    // ok/ 下 k0 真的删了，k1 还在。
    fs.writeFileSync(path.join(root, 'bad', 'b0.jpg'), 'x')
    fs.writeFileSync(path.join(root, 'bad', 'b1.jpg'), 'x')
    fs.writeFileSync(path.join(root, 'ok', 'k1.jpg'), 'x')
    breakDir('bad')

    const { syncMetadata } = await loadSync(root)
    const r = await syncMetadata(sqlite, { log: quiet })

    // bad/ 的两行被豁免（文件还在，删了就是抹掉原图）；ok/k0 照常清掉。
    expect(r.removed).toBe(1)
    expect(r.skippedDeletes).toBe(2)
    expect(postCount(sqlite)).toBe(3)
    expect(fs.existsSync(path.join(root, 'bad', 'b0.jpg'))).toBe(true)
  })

  // 一张表把闸门的四种情形排开：库多大、盘上还剩几个、放不放行。
  it.each([
    // 200 行里 150 个不见了（75%）→ 超过 50% 的闸门，一行不删
    { name: '删除量超过一半时跳过', posts: 200, onDisk: 50, allow: false, removed: 0, skipped: 150 },
    // 同样的输入，但显式放行
    { name: '设了 PICTORIA_SYNC_ALLOW_MASS_DELETE 就照删', posts: 200, onDisk: 50, allow: true, removed: 150, skipped: 0 },
    // 闸门不能把正常的对账也挡掉：删掉几张图仍然要如实同步
    { name: '正常比例的删除照常执行', posts: 200, onDisk: 190, allow: false, removed: 10, skipped: 0 },
    // 小库不设比例上限 —— 那里"删掉一半"是三张图的事
    { name: '小库不受比例闸门限制', posts: 4, onDisk: 1, allow: false, removed: 3, skipped: 0 },
  ])('$name', async ({ posts, onDisk, allow, removed, skipped }) => {
    const { root, sqlite } = seedLibrary(posts, onDisk)
    if (allow)
      process.env.PICTORIA_SYNC_ALLOW_MASS_DELETE = '1'

    const { syncMetadata } = await loadSync(root)
    const r = await syncMetadata(sqlite, { log: quiet })

    expect(r.removed).toBe(removed)
    expect(r.skippedDeletes).toBe(skipped)
    expect(postCount(sqlite)).toBe(posts - removed)
    // 跳过时磁盘上幸存的文件一个都不能被 unlink
    if (skipped)
      expect(fs.readdirSync(root)).toHaveLength(onDisk)
  })

  // 手动端点的按次放行：确认动作只对这一次生效，不用改进程环境。
  it('allowMassDelete 按次放行超比例删除', async () => {
    const { root, sqlite } = seedLibrary(200, 50)

    const { syncMetadata } = await loadSync(root)
    const r = await syncMetadata(sqlite, { log: quiet, allowMassDelete: true })

    expect(r.removed).toBe(150)
    expect(r.skippedDeletes).toBe(0)
    expect(postCount(sqlite)).toBe(50)
  })

  // 扫描不完整只挡删除；新文件照常入库，否则一个读不动的子目录会连带冻结整个导入。
  it('扫描不完整仍然登记新文件', async () => {
    const { root, sqlite } = seedLibrary(0, 0)
    fs.mkdirSync(path.join(root, 'ok'), { recursive: true })
    fs.mkdirSync(path.join(root, 'bad'), { recursive: true })
    fs.writeFileSync(path.join(root, 'ok', 'new.jpg'), 'x')
    breakDir('bad')

    const { scanLibrary, syncMetadata } = await loadSync(root)
    // 先证明扫描真的不完整 —— 否则这条断言对完全成功的扫描也成立，测了个空。
    const scan = await scanLibrary(root, { log: quiet })
    expect(scan.failedDirs).toEqual(['bad'])

    const r = await syncMetadata(sqlite, { log: quiet })
    expect(r.added).toBe(1)
  })
})
