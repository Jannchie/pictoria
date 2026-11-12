/**
 * 通用的一批（`runBatch`）和循环的唤醒 —— 用假的 `tasks.call` 和一个跑完迁移的临时库，
 * 不碰 GPU、不碰 cairnq。
 *
 * 六个 worker 原来各写一段"取待办 → 提交 → 落库 → 拉黑 → 返回 {done, failed}"，合成
 * 一份之后，每个 worker 的差别全在 `WorkerSpec` 里。这里钉住的是那些"写错了不报错"的
 * 不变量：扫空返回 `null` 而不是 `{0, 0}`、拉黑策略按规格走（silva 不拉黑）、tagger 被
 * 遮住的计入 `failed`、不带 id 的重新待办信号当场退水位、文件不在盘上的让出队首、批次 key
 * 和 conflict 的形状。
 *
 * 图库根指到一个临时目录（`paths.ts` 的 `targetDir()` 是惰性的，第一次调用前改环境变量
 * 就行）：`runBatch` 提交前会查原图在不在盘上，`insertPost` 默认把文件也写出来。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { TAGGER_MODEL } from '@pictoria/contracts'
import {
  BACKFILL_WORKERS,
  createTestDb,
  failureKey,
  MISSING_FILE_ERROR,
  notifyRepending,
  type SqliteHandle,
  upsertVectors,
} from '@pictoria/db'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBatch, startBackfill } from './scheduler.js'
import { restoreReturnedFiles } from './sync.js'
import { BACKFILL_SPECS, basicsSpec, runOneShot, silvaSpecs, taggerSpec, type WorkerSpec } from './workers.js'
import { postAbsPath, targetDir, thumbnailPathFor } from './paths.js'

const library = fs.mkdtempSync(path.join(os.tmpdir(), 'pictoria-scheduler-test-'))
process.env.PICTORIA_TARGET_DIR = library
afterAll(() => fs.rmSync(library, { recursive: true, force: true }))

const quiet = { info: () => {}, warn: () => {} }

let sqlite: SqliteHandle

/** 记下每一次提交，按脚本回结果。 */
function fakeTasks(reply: (payload: any) => unknown) {
  const calls: Array<{ task: string, payload: any, opts: any }> = []
  return {
    calls,
    tasks: {
      call: async (task: { name: string }, payload: any, opts: any) => {
        calls.push({ task: task.name, payload, opts })
        return reply(payload)
      },
    } as any,
  }
}

function insertPost(id: number, extension = 'jpg', { file = true } = {}): void {
  sqlite
    .prepare('INSERT INTO posts (id, file_path, file_name, extension) VALUES (?, ?, ?, ?)')
    .run(id, 'dir', `f${id}`, extension)
  if (file)
    writeFile(id, extension)
}

function writeFile(id: number, extension = 'jpg'): void {
  const abs = postAbsPath(`dir/f${id}.${extension}`)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, 'x')
}

/** tagger 对一张图的结果。通用机制的用例拿 tagger 当载体（图片路径输入、会拉黑）。 */
function tagged(postId: number, general: string[] = ['cat']) {
  return { postId, tags: { general, character: [], copyright: [], style: [], meta: [] }, rating: 'general' }
}

/** 一个 tagger 回包；缺省是"一条都没回"。 */
function taggerReply(results: Array<ReturnType<typeof tagged>> = [], failures: Array<{ postId: number, error: string }> = []) {
  return { model: TAGGER_MODEL, results, failures }
}

/** 提交了几张就给几张打上标。 */
function tagEverything(payload: { items: Array<{ postId: number }> }) {
  return taggerReply(payload.items.map(i => tagged(i.postId)))
}

function failures(): Array<{ post_id: number, worker: string }> {
  return sqlite.prepare<[], { post_id: number, worker: string }>('SELECT post_id, worker FROM post_process_failures ORDER BY post_id').all()
}

beforeEach(() => {
  sqlite = createTestDb()
  expect(targetDir()).toBe(path.resolve(library))
})

afterEach(() => {
  sqlite.close()
  fs.rmSync(path.join(library, 'dir'), { recursive: true, force: true })
})

describe('规格表', () => {
  it('和 @pictoria/db 的 BACKFILL_WORKERS 逐个对齐（加名字忘了加规格会先红在这里）', () => {
    expect(BACKFILL_SPECS.map(s => s.name)).toEqual([...BACKFILL_WORKERS])
  })

  it('拉黑策略：silva 家族不拉黑，其余都拉黑', () => {
    expect(Object.fromEntries(BACKFILL_SPECS.map(s => [s.name, s.blacklist]))).toEqual({
      basics: true,
      silva: false,
      tagger: true,
      embedding: true,
    })
  })
})

describe('runBatch', () => {
  it('待办扫空 → null，不提交任务', async () => {
    const { tasks, calls } = fakeTasks(() => { throw new Error('should not be called') })
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toBeNull()
    expect(calls).toEqual([])
  })

  it('worker 一条都没回 → {0, 0}，不是 null', async () => {
    insertPost(1)
    const { tasks } = fakeTasks(() => taggerReply())
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet }))
      .toEqual({ done: 0, failed: 0, written: 0 })
  })

  it('提交参数：队列、批次 key 列出全部成员、reuse-succeeded；路径是绝对路径', async () => {
    insertPost(1)
    insertPost(2)
    const { tasks, calls } = fakeTasks(() => taggerReply())
    await runBatch(sqlite, tasks, taggerSpec, { log: quiet })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.task).toBe('tagger')
    expect(calls[0]!.opts).toMatchObject({ queue: 'gpu', key: `tagger:${TAGGER_MODEL}:1,2`, conflict: 'reuse-succeeded' })
    expect(calls[0]!.payload.items.map((i: { postId: number }) => i.postId)).toEqual([1, 2])
    for (const item of calls[0]!.payload.items)
      expect(path.isAbsolute(item.path)).toBe(true)
  })

  it('失败按规格拉黑：tagger 写进自己的桶，并计入 failed', async () => {
    insertPost(1)
    insertPost(2)
    const { tasks } = fakeTasks(() => taggerReply([tagged(1)], [{ postId: 2, error: 'unreadable' }]))
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet }))
      .toEqual({ done: 1, failed: 1, written: 1 })
    expect(failures()).toEqual([{ post_id: 2, worker: failureKey('tagger') }])
    // 拉黑之后下一轮不再选它（先把水位线退到 0，证明不是水位线挡住的）
    notifyRepending(sqlite, 'tagger')
    expect(taggerSpec.listPending(sqlite, 10)).toEqual([])
  })

  it('silva 不拉黑：worker 回了失败也不写黑名单', async () => {
    insertPost(1)
    const vec = new Float32Array(1152).fill(0.01)
    upsertVectors(sqlite, [{ postId: 1, embedding: Buffer.from(vec.buffer) }])
    const spec = silvaSpecs.silva
    // SilvaResult 没有 failures 字段；就算 worker 多回了一个，也不该被当成拉黑依据。
    const { tasks, calls } = fakeTasks(() => ({ scores: [], failures: [{ postId: 1, error: 'boom' }] }))
    expect(await runBatch(sqlite, tasks, spec, { log: quiet }))
      .toEqual({ done: 0, failed: 0, written: 0 })
    expect(calls[0]!.opts.key).toBe('silva:1')
    expect(calls[0]!.payload.scorer).toBe('silva')
    expect(failures()).toEqual([])
    // 还是待办，下一轮重试
    notifyRepending(sqlite, 'silva')
    expect(spec.listPending(sqlite, 10)).toEqual([{ postId: 1 }])
  })

  it('silva：待办说有向量、取的时候没有 → {0, 0}，不提交', async () => {
    insertPost(1)
    const spec: WorkerSpec<any, any, any> = {
      ...silvaSpecs.silva,
      listPending: () => [{ postId: 1 }],
    }
    const { tasks, calls } = fakeTasks(() => { throw new Error('should not be called') })
    expect(await runBatch(sqlite, tasks, spec, { log: quiet })).toEqual({ done: 0, failed: 0, written: 0 })
    expect(calls).toEqual([])
  })

  it('tagger：被手工标签遮住的拉黑并计入 failed；key 带模型名', async () => {
    insertPost(1)
    insertPost(2)
    insertPost(3)
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('1girl')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, '1girl', 0)").run()
    const row = (postId: number, general: string[]) => ({
      postId,
      tags: { general, character: [], copyright: [], style: [], meta: [] },
      rating: 'general',
    })
    const { tasks, calls } = fakeTasks(() => ({
      model: TAGGER_MODEL,
      results: [row(1, ['1girl']), row(2, ['cat'])],
      failures: [{ postId: 3, error: 'unreadable' }],
    }))
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet }))
      .toEqual({ done: 2, failed: 2, written: 2 })
    expect(calls[0]!.opts.key).toBe(`tagger:${TAGGER_MODEL}:1,2,3`)
    expect(failures()).toEqual([
      { post_id: 1, worker: 'tagger' },
      { post_id: 3, worker: 'tagger' },
    ])
  })

  it('tagger 单张重算：被遮住的不拉黑（用户会再点一次）', async () => {
    insertPost(1)
    sqlite.prepare('INSERT INTO tags(name) VALUES (?)').run('1girl')
    sqlite.prepare("INSERT INTO post_has_tag(post_id, tag_name, is_auto) VALUES (1, '1girl', 0)").run()
    const { tasks } = fakeTasks(() => ({
      model: TAGGER_MODEL,
      results: [{ postId: 1, tags: { general: ['1girl'], character: [], copyright: [], style: [], meta: [] }, rating: 'general' }],
      failures: [],
    }))
    await runOneShot(sqlite, tasks, taggerSpec, [{ postId: 1, relPath: 'dir/f1.jpg' }])
    expect(failures()).toEqual([])
  })

  it('basics：走 IO 队列，payload 带缩略图路径', async () => {
    insertPost(1)
    const { tasks, calls } = fakeTasks(() => ({
      rows: [{ postId: 1, sha256: 'abc', size: 1, arthash: 'h', width: 2, height: 3, colors: [], dominantLab: [1, 2, 3], colorError: null }],
      failures: [],
    }))
    expect(await runBatch(sqlite, tasks, basicsSpec, { log: quiet }))
      .toEqual({ done: 1, failed: 0, written: 1 })
    expect(calls[0]!.opts).toMatchObject({ queue: 'io', key: 'basics:1' })
    expect(calls[0]!.payload.items).toEqual([{
      postId: 1,
      path: expect.any(String),
      thumbnailPath: thumbnailPathFor('dir/f1.jpg'),
      hasSha256: false,
      hasArthash: false,
      hasColor: false,
    }])
    notifyRepending(sqlite, 'basics')
    expect(basicsSpec.listPending(sqlite, 10)).toEqual([])
  })

  it('不带 id 的重新待办信号当场把水位线退到 0：水位线以下的老 post 下一轮就捡得到', async () => {
    insertPost(1)
    const { tasks } = fakeTasks(tagEverything)
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toEqual({ done: 1, failed: 0, written: 1 })
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toBeNull() // 水位线推到 MAX(id)+1

    sqlite.exec('DELETE FROM post_has_tag') // 让 post 1 在水位线以下重新变成待办
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toBeNull() // 没人喊：看不见
    notifyRepending(sqlite, 'tagger')
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toEqual({ done: 1, failed: 0, written: 1 })
  })
})

describe('文件不在盘上', () => {
  it('提交前剔掉、记成可恢复的黑名单、计入 failed —— 队首不再卡住后面的图', async () => {
    insertPost(1, 'jpg', { file: false })
    insertPost(2, 'jpg', { file: false })
    insertPost(3)
    const { tasks, calls } = fakeTasks(tagEverything)
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toEqual({ done: 1, failed: 2, written: 1 })
    expect(calls.map(c => c.payload.items.map((i: { postId: number }) => i.postId))).toEqual([[3]])
    expect(sqlite.prepare('SELECT post_id, worker, error FROM post_process_failures ORDER BY post_id').all()).toEqual([
      { post_id: 1, worker: 'tagger', error: MISSING_FILE_ERROR },
      { post_id: 2, worker: 'tagger', error: MISSING_FILE_ERROR },
    ])
    notifyRepending(sqlite, 'tagger')
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toBeNull()
  })

  it('整批都不在盘上：不提交，但算推进（不是 {0, 0} 的空转）', async () => {
    insertPost(1, 'jpg', { file: false })
    const { tasks, calls } = fakeTasks(() => { throw new Error('should not be called') })
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toEqual({ done: 0, failed: 1, written: 0 })
    expect(calls).toEqual([])
  })

  it('文件回来了：sync 清掉这类黑名单并发重新待办信号，下一轮照常处理；真失败的不动', async () => {
    insertPost(1, 'jpg', { file: false })
    insertPost(2, 'jpg', { file: false })
    const { tasks } = fakeTasks(tagEverything)
    await runBatch(sqlite, tasks, taggerSpec, { log: quiet })
    // 另一条循环（basics）在 post 2 上的真失败：不是"文件不在盘上"这一类，不该被清掉
    sqlite.prepare(`INSERT INTO post_process_failures (post_id, worker, error) VALUES (2, 'basics', 'unreadable')`).run()
    expect(await restoreReturnedFiles(sqlite, quiet)).toBe(0) // 还没回来

    writeFile(1)
    const heard: string[][] = []
    const off = (await import('@pictoria/db')).onRepending(sqlite, ws => heard.push([...ws]))
    expect(await restoreReturnedFiles(sqlite, quiet)).toBe(1)
    off()
    expect(heard).toEqual([['tagger']])
    expect(sqlite.prepare('SELECT post_id, worker, error FROM post_process_failures ORDER BY post_id, worker').all()).toEqual([
      { post_id: 2, worker: 'basics', error: 'unreadable' },
      { post_id: 2, worker: 'tagger', error: MISSING_FILE_ERROR },
    ])
    expect(await runBatch(sqlite, tasks, taggerSpec, { log: quiet })).toEqual({ done: 1, failed: 0, written: 1 })
  })
})

describe('循环订阅重新待办信号', () => {
  it('只叫醒被点名的那条循环', async () => {
    const seen: Record<string, number> = { basics: 0, tagger: 0 }
    const stub = (name: 'basics' | 'tagger'): WorkerSpec<any, any, any> => ({
      ...(name === 'basics' ? basicsSpec : taggerSpec),
      listPending: () => {
        seen[name]! += 1
        return []
      },
      countPending: () => [0],
    })
    const { tasks } = fakeTasks(() => { throw new Error('should not be called') })
    const handles = [startBackfill(sqlite, tasks, stub('basics'), { log: quiet }), startBackfill(sqlite, tasks, stub('tagger'), { log: quiet })]
    try {
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual({ basics: 1, tagger: 1 }) // 各扫一次，空，进入 30 秒空等

      notifyRepending(sqlite, 'tagger')
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual({ basics: 1, tagger: 2 })
    }
    finally {
      for (const h of handles) h.stop()
    }
  })

  it('信号来时一批正跑到一半：这一批跑完不空等，接着再扫一轮', async () => {
    let scans = 0
    let release: () => void = () => {}
    const spec: WorkerSpec<any, any, any> = {
      ...taggerSpec,
      listPending: () => {
        scans += 1
        return scans === 1 ? [{ postId: 1, relPath: 'dir/f1.jpg' }] : []
      },
      countPending: () => [0],
    }
    insertPost(1)
    const { tasks } = fakeTasks(() => new Promise((resolve) => {
      release = () => resolve(taggerReply())
    }))
    const handle = startBackfill(sqlite, tasks, spec, { log: quiet })
    try {
      await new Promise(r => setTimeout(r, 20))
      notifyRepending(sqlite, 'tagger')
      release()
      await new Promise(r => setTimeout(r, 20))
      expect(scans).toBe(2)
    }
    finally {
      handle.stop()
    }
  })
})
