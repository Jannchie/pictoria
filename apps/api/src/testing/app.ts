/**
 * 路由集成测试的底座：一个跑完迁移的内存库 + 一个临时图库目录 + 整条 `createApp` 栈。
 *
 * ```ts
 * const t = createTestApp()                 // 每个用例一个新库
 * const id = t.insertPost('a', 'x', 'png', { file: true })
 * const res = await t.app.request(`/v2/posts/${id}/score`, { method: 'PUT', ... })
 * t.close()                                 // afterEach 里调
 * ```
 *
 * ## 为什么图库目录是"每个测试文件一个"，而库是"每个用例一个"
 *
 * 路由经 `paths.ts` 的 `targetDir()` 找图库根，那是 `once()` 缓存的进程级值 —— 第一次
 * 调用时读 `PICTORIA_TARGET_DIR`，之后再改环境变量无效。把 `targetDir` 也做成
 * `createApp` 的注入项要穿过 `sync.ts`、`dedup.ts`、`post-files.ts`、`workers.ts` 和
 * 五个路由文件，改动面远大于这次要解决的问题，所以这里退一步：**第一次**
 * `createTestApp()` 时（任何人调 `targetDir()` 之前）把环境变量指到一个新建的临时目录，
 * 整个测试文件共用它；vitest 默认每个测试文件一个独立的模块图，下一个文件会拿到
 * 自己的目录。用例之间由 `close()` 清空目录内容（目录本身留着，缓存的路径仍然有效）。
 *
 * 万一某个模块在顶层就调了 `targetDir()`（于是锁死的是别的目录），`ensureLibrary`
 * 会当场抛错，而不是让测试往真实图库里写文件。
 *
 * `DB_PATH` / `TASKS_DB_PATH` 也一并指进临时目录：路由已经不碰 `getDb()`/`getTasks()`，
 * 这是兜底 —— 哪天有人在路由里又调了单例，最坏是在临时目录里建一个空库，而不是连上
 * 生产库。
 */
import type { CairnQ } from 'cairnq'
import type { SqliteHandle } from '@pictoria/db'
import type { TaskSource } from '../env.js'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createTestDb } from '@pictoria/db'
import { afterAll } from 'vitest'
import { createApp } from '../app.js'
import { targetDir, thumbnailPathFor } from '../paths.js'

let libraryRoot: string | undefined

// 这个测试文件跑完就把整个临时图库删掉（用例之间只清内容，见 `close()`）。必须在
// 模块顶层注册：import 发生在收集阶段，此时挂上的是当前测试文件的根 suite；放进
// `beforeEach` 里调的 `createTestApp()` 就挂不上了。
afterAll(() => {
  if (libraryRoot)
    fs.rmSync(libraryRoot, { recursive: true, force: true })
})

function ensureLibrary(): string {
  if (!libraryRoot) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-api-test-'))
    process.env.PICTORIA_TARGET_DIR = root
    process.env.DB_PATH = path.join(root, '.pictoria', 'must-not-open.sqlite')
    process.env.TASKS_DB_PATH = path.join(root, '.pictoria', 'must-not-open-tasks.sqlite')
    libraryRoot = root
  }
  if (targetDir() !== path.resolve(libraryRoot))
    throw new Error(`targetDir() 已被锁定在 ${targetDir()}，不是测试图库 ${libraryRoot} —— 有模块在顶层调了 paths.ts`)
  return libraryRoot
}

/** 一次 `tasks.call` 的记录。 */
export interface TaskCall {
  task: string
  payload: any
  opts: any
}

/**
 * 假的 cairnq：记下每次提交，按 `reply` 回结果。`reply` 抛错就模拟任务失败。
 *
 * 不传 `reply` 时任何提交都抛 —— 不该碰 worker 的路径碰了就红。
 */
export function fakeTasks(reply?: (task: string, payload: any) => unknown): TaskSource & { calls: TaskCall[] } {
  const calls: TaskCall[] = []
  const tasks = {
    call: async (task: { name: string }, payload: any, opts: any) => {
      calls.push({ task: task.name, payload, opts })
      if (!reply)
        throw new Error(`unexpected task submission: ${task.name}`)
      return reply(task.name, payload)
    },
    stats: async () => ({}),
  } as unknown as CairnQ
  return { calls, get: async () => tasks, peek: () => null }
}

export interface InsertPostOptions {
  /** 在图库里真的写出这个文件（内容随意）。 */
  file?: boolean
  /** 同时写出缩略图。 */
  thumbnail?: boolean
  score?: number
  rating?: number
}

export function createTestApp(options: { tasks?: TaskSource } = {}) {
  const root = ensureLibrary()
  const sqlite: SqliteHandle = createTestDb()
  const tasks = options.tasks ?? fakeTasks()
  const app = createApp({ db: sqlite, tasks })

  /** 插一行 post，返回 id；`filePath` 是相对图库根的目录（根是 `'.'`）。 */
  function insertPost(filePath: string, fileName: string, extension: string, opts: InsertPostOptions = {}): number {
    const { lastInsertRowid } = sqlite
      .prepare('INSERT INTO posts (file_path, file_name, extension, score, rating) VALUES (?, ?, ?, ?, ?)')
      .run(filePath, fileName, extension, opts.score ?? 0, opts.rating ?? 0)
    const rel = path.posix.join(filePath, `${fileName}.${extension}`)
    if (opts.file)
      writeFile(rel)
    if (opts.thumbnail)
      writeFile(path.relative(root, thumbnailPathFor(rel)))
    return Number(lastInsertRowid)
  }

  /** 在图库里写一个文件（相对路径），父目录按需建出来。返回绝对路径。 */
  function writeFile(rel: string, content: string | Buffer = 'x'): string {
    const abs = path.resolve(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    return abs
  }

  /** 关库并清空图库目录的内容（目录本身留着：`targetDir()` 已经缓存了它）。 */
  function close(): void {
    sqlite.close()
    for (const name of fs.readdirSync(root))
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }

  return { app, sqlite, tasks, root, insertPost, writeFile, close }
}

export type TestApp = ReturnType<typeof createTestApp>

/** `app.request` 的 JSON 便捷版：自动带 content-type，回 `{ status, body }`。 */
export async function requestJson<T = any>(
  app: TestApp['app'],
  url: string,
  init: { method?: string, body?: unknown } = {},
): Promise<{ status: number, body: T }> {
  const res = await app.request(url, {
    method: init.method ?? 'GET',
    ...(init.body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
}
