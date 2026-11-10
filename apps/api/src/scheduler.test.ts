/**
 * 通用的一批（`runBatch`）和循环的唤醒 —— 用假的 `tasks.call` 和一个跑完迁移的临时库，
 * 不碰 GPU、不碰 cairnq。
 *
 * 六个 worker 原来各写一段"取待办 → 提交 → 落库 → 拉黑 → 返回 {done, failed}"，合成
 * 一份之后，每个 worker 的差别全在 `WorkerSpec` 里。这里钉住的是那些"写错了不报错"的
 * 不变量：扫空返回 `null` 而不是 `{0, 0}`、拉黑策略按规格走（silva 不拉黑）、tagger 被
 * 遮住的计入 `failed`、`force` 真的清水位线、批次 key 和 conflict 的形状。
 */
import path from 'node:path'
import { TAGGER_MODEL } from '@pictoria/contracts'
import {
  BACKFILL_WORKERS,
  createTestDb,
  failureKey,
  notifyRepending,
  type SqliteHandle,
  upsertVectors,
} from '@pictoria/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runBatch, startBackfill } from './scheduler.js'
import { BACKFILL_SPECS, basicsSpec, runOneShot, silvaSpecs, taggerSpec, waifuSpec, type WorkerSpec } from './workers.js'
import { thumbnailPathFor } from './paths.js'

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

function insertPost(id: number, extension = 'jpg'): void {
  sqlite
    .prepare('INSERT INTO posts (id, file_path, file_name, extension) VALUES (?, ?, ?, ?)')
    .run(id, 'dir', `f${id}`, extension)
}

function failures(): Array<{ post_id: number, worker: string }> {
  return sqlite.prepare<[], { post_id: number, worker: string }>('SELECT post_id, worker FROM post_process_failures ORDER BY post_id').all()
}

beforeEach(() => {
  sqlite = createTestDb()
})

afterEach(() => {
  sqlite.close()
})

describe('规格表', () => {
  it('和 @pictoria/db 的 BACKFILL_WORKERS 逐个对齐（加名字忘了加规格会先红在这里）', () => {
    expect(BACKFILL_SPECS.map(s => s.name)).toEqual([...BACKFILL_WORKERS])
  })

  it('拉黑策略：silva 家族不拉黑，其余都拉黑', () => {
    expect(Object.fromEntries(BACKFILL_SPECS.map(s => [s.name, s.blacklist]))).toEqual({
      basics: true,
      silva: false,
      silva_luna: false,
      waifu: true,
      tagger: true,
      embedding: true,
    })
  })
})

describe('runBatch', () => {
  it('待办扫空 → null，不提交任务', async () => {
    const { tasks, calls } = fakeTasks(() => { throw new Error('should not be called') })
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet })).toBeNull()
    expect(calls).toEqual([])
  })

  it('worker 一条都没回（文件不在盘上被静默丢掉）→ {0, 0}，不是 null', async () => {
    insertPost(1)
    const { tasks } = fakeTasks(() => ({ scores: [], failures: [] }))
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet }))
      .toEqual({ done: 0, failed: 0, written: 0 })
  })

  it('提交参数：队列、批次 key 列出全部成员、reuse-succeeded；路径是绝对路径', async () => {
    insertPost(1)
    insertPost(2)
    const { tasks, calls } = fakeTasks(() => ({ scores: [], failures: [] }))
    await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.task).toBe('waifu')
    expect(calls[0]!.opts).toMatchObject({ queue: 'gpu', key: 'waifu:1,2', conflict: 'reuse-succeeded' })
    for (const item of calls[0]!.payload.items)
      expect(path.isAbsolute(item.path)).toBe(true)
  })

  it('失败按规格拉黑：waifu 写进自己的桶，并计入 failed', async () => {
    insertPost(1)
    insertPost(2)
    const { tasks } = fakeTasks(() => ({ scores: [{ postId: 1, score: 7 }], failures: [{ postId: 2, error: 'unreadable' }] }))
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet }))
      .toEqual({ done: 1, failed: 1, written: 1 })
    expect(failures()).toEqual([{ post_id: 2, worker: failureKey('waifu') }])
    // 拉黑之后下一轮不再选它
    expect(waifuSpec.listPending(sqlite, 10, { force: true })).toEqual([])
  })

  it('silva 不拉黑：worker 回了失败也不写黑名单', async () => {
    insertPost(1)
    const vec = new Float32Array(1152).fill(0.01)
    upsertVectors(sqlite, [{ postId: 1, embedding: Buffer.from(vec.buffer) }])
    const spec = silvaSpecs.silva
    // SilvaResult 没有 failures 字段；就算 worker 多回了一个，也不该被当成拉黑依据。
    const { tasks, calls } = fakeTasks(() => ({ scores: [], failures: [{ postId: 1, error: 'boom' }] }))
    expect(await runBatch(sqlite, tasks, spec, { force: false, log: quiet }))
      .toEqual({ done: 0, failed: 0, written: 0 })
    expect(calls[0]!.opts.key).toBe('silva:1')
    expect(calls[0]!.payload.scorer).toBe('silva')
    expect(failures()).toEqual([])
    // 还是待办，下一轮重试
    expect(spec.listPending(sqlite, 10, { force: true })).toEqual([{ postId: 1 }])
  })

  it('silva：待办说有向量、取的时候没有 → {0, 0}，不提交', async () => {
    insertPost(1)
    const spec: WorkerSpec<any, any, any> = {
      ...silvaSpecs.silva,
      listPending: () => [{ postId: 1 }],
    }
    const { tasks, calls } = fakeTasks(() => { throw new Error('should not be called') })
    expect(await runBatch(sqlite, tasks, spec, { force: false, log: quiet })).toEqual({ done: 0, failed: 0, written: 0 })
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
    expect(await runBatch(sqlite, tasks, taggerSpec, { force: false, log: quiet }))
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
    expect(await runBatch(sqlite, tasks, basicsSpec, { force: false, log: quiet }))
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
    expect(basicsSpec.listPending(sqlite, 10, { force: true })).toEqual([])
  })

  it('force：水位线以下重新变成待办的老 post，不 force 看不见，force 才捡得到', async () => {
    insertPost(1)
    const { tasks } = fakeTasks(() => ({ scores: [{ postId: 1, score: 7 }], failures: [] }))
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet })).toEqual({ done: 1, failed: 0, written: 1 })
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet })).toBeNull() // 水位线推到 MAX(id)+1

    sqlite.exec('DELETE FROM post_waifu_scores') // 让 post 1 在水位线以下重新变成待办
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: false, log: quiet })).toBeNull()
    expect(await runBatch(sqlite, tasks, waifuSpec, { force: true, log: quiet })).toEqual({ done: 1, failed: 0, written: 1 })
  })
})

describe('循环订阅重新待办信号', () => {
  it('只叫醒被点名的那条循环，并让它下一轮带 force', async () => {
    const seen: Record<string, boolean[]> = { waifu: [], tagger: [] }
    const stub = (name: 'waifu' | 'tagger'): WorkerSpec<any, any, any> => ({
      ...(name === 'waifu' ? waifuSpec : taggerSpec),
      listPending: (_s, _l, { force }) => {
        seen[name]!.push(force)
        return []
      },
      countPending: () => [0],
    })
    const { tasks } = fakeTasks(() => { throw new Error('should not be called') })
    const handles = [startBackfill(sqlite, tasks, stub('waifu'), { log: quiet }), startBackfill(sqlite, tasks, stub('tagger'), { log: quiet })]
    try {
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual({ waifu: [false], tagger: [false] }) // 各扫一次，空，进入 30 秒空等

      notifyRepending(sqlite, 'tagger')
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual({ waifu: [false], tagger: [false, true] })
    }
    finally {
      for (const h of handles) h.stop()
    }
  })
})

describe('一批失败之后 force 旗的去留', () => {
  function stubSpec(seen: boolean[], listThrows: () => boolean): WorkerSpec<any, any, any> {
    return {
      ...waifuSpec,
      listPending: (_s, _l, { force }) => {
        seen.push(force)
        if (listThrows())
          throw new Error('scan failed')
        return [{ postId: 1, relPath: 'dir/f1.jpg' }]
      },
      countPending: () => [0],
    }
  }

  it('待办查询已经跑过、异常出在 tasks.call 上 → 不还回去（worker 故障期间不反复整库重扫）', async () => {
    const seen: boolean[] = []
    const { tasks } = fakeTasks(() => { throw new Error('worker down') })
    const handle = startBackfill(sqlite, tasks, stubSpec(seen, () => false), { log: quiet })
    try {
      await new Promise(r => setTimeout(r, 20))
      notifyRepending(sqlite, 'waifu')
      await new Promise(r => setTimeout(r, 20))
      notifyRepending(sqlite, 'waifu', 1) // 带 id：只叫醒，不要求 force
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual([false, true, false])
    }
    finally {
      handle.stop()
    }
  })

  it('异常出在待办查询本身 → 还回去，下一轮仍然 force', async () => {
    const seen: boolean[] = []
    const { tasks } = fakeTasks(() => ({ scores: [], failures: [] }))
    const handle = startBackfill(sqlite, tasks, stubSpec(seen, () => seen.at(-1) === true && seen.length === 2), { log: quiet })
    try {
      await new Promise(r => setTimeout(r, 20))
      notifyRepending(sqlite, 'waifu')
      await new Promise(r => setTimeout(r, 20))
      notifyRepending(sqlite, 'waifu', 1)
      await new Promise(r => setTimeout(r, 20))
      expect(seen).toEqual([false, true, true])
    }
    finally {
      handle.stop()
    }
  })
})
