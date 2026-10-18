/**
 * 跨语言任务契约 —— `server/tests/test_task_contracts.py` 的孪生测试。
 *
 * 两侧读的是同一批 `fixtures/tasks/<name>.json`（每个 cairnq 任务一份示例 payload /
 * result，文件名就是任务名）。这一侧钉住"fixture 与 `tasks.ts` 的接口一致"：任务名、队列、以及 payload /
 * result 每一层对象的**键集合**与接口字段完全相同 —— 多一个、少一个、改个名都红。
 * Python 侧钉住另一半：worker 注册了同名同队列的 handler，handler 只读 fixture 里有的
 * 键，返回值的键集合与 fixture 相同。两半拼起来，改名就不可能只改一侧。
 *
 * 键集合从哪儿来：接口在运行时不存在，所以每个任务在下面写一份 `Shape`。`Shape<T>`
 * 是从接口**推导**出来的类型，写漏、写多、写错一个键都过不了 `tsc`（`pnpm typecheck`）；
 * 运行时再拿它去和 fixture 逐层比。
 */
import type { TaskDef } from 'cairnq'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  basicsTask,
  captionTask,
  danbooruDownloadTask,
  danbooruListTask,
  dedupTask,
  embeddingTask,
  lpipsVerifyTask,
  queueOf,
  rotateTask,
  SILVA_SCORERS,
  silvaTask,
  TASK_QUEUES,
  taggerTask,
  textEmbedTask,
  thumbnailTask,
  urlDownloadTask,
  urlScanTask,
  waifuTask,
} from './tasks.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures')

// ─── Shape：从接口推导出的"键集合规格" ─────────────────────────────────

/** 叶子的 JSON 类型。可空字段的 null 在运行时一律放行（规格不记可空性）。 */
type Leaf = 'string' | 'number' | 'boolean' | 'array'

type LeafOf<T> = [T] extends [string] ? 'string'
  : [T] extends [number] ? 'number'
    : [T] extends [boolean] ? 'boolean'
      : never

/**
 * `T` 的结构规格：
 *
 * * 标量 → 它的 JSON 类型名；
 * * 标量数组 / 元组（`string[]`、`[number, number, number]`）→ `'array'`；
 * * 对象数组 → `[元素的规格]`；
 * * 字符串索引的映射（`Record<string, number>`）→ `'record'`，键是数据不是字段；
 * * 其余对象 → 每个字段（含可选字段）一项，必须写全。
 */
type Shape<T> = [NonNullable<T>] extends [string | number | boolean] ? LeafOf<NonNullable<T>>
  : NonNullable<T> extends readonly (infer U)[]
    ? ([NonNullable<U>] extends [string | number | boolean] ? 'array'
        : NonNullable<U> extends readonly unknown[] ? 'array'
          : readonly [Shape<U>])
    : string extends keyof NonNullable<T> ? 'record'
      : { readonly [K in keyof Required<NonNullable<T>>]-?: Shape<NonNullable<T>[K]> }

type AnyShape = Leaf | 'record' | readonly [AnyShape] | { readonly [key: string]: AnyShape }

interface Contract {
  task: TaskDef<unknown, unknown>
  payload: AnyShape
  result: AnyShape
}

/** `P` / `R` 只从 `task` 推断，两个规格必须严格符合它们。队列来自 `TASK_QUEUES`。 */
function contract<P, R>(
  task: TaskDef<P, R>,
  payload: NoInfer<Shape<P>>,
  result: NoInfer<Shape<R>>,
): Contract {
  return { task: task as TaskDef<unknown, unknown>, payload: payload as AnyShape, result: result as AnyShape }
}

// ─── 每个任务的规格 ────────────────────────────────────────────────────

const imageItem = { postId: 'number', path: 'string' } as const
const failure = { postId: 'number', error: 'string' } as const
const postRow = {
  filePath: 'string',
  fileName: 'string',
  extension: 'string',
  source: 'string',
  rating: 'number',
  publishedAt: 'string',
  tags: 'record',
} as const
const danbooruItem = { fileUrl: 'string', fileSize: 'number', row: postRow } as const
const galleryItem = {
  downloadUrl: 'string',
  fileName: 'string',
  extension: 'string',
  source: 'string',
  category: 'string',
  creator: 'string',
  rating: 'number',
  publishedAt: 'string',
  tagsByCategory: 'record',
} as const

const CONTRACTS: Contract[] = [
  contract(silvaTask, {
    scorer: 'string',
    items: [{ postId: 'number', embedding: 'string' }],
  }, {
    scores: [{ postId: 'number', score: 'number' }],
  }),
  contract(waifuTask, { items: [imageItem] }, {
    scores: [{ postId: 'number', score: 'number' }],
    failures: [failure],
  }),
  contract(taggerTask, { items: [imageItem] }, {
    model: 'string',
    results: [{
      postId: 'number',
      tags: { general: 'array', character: 'array', copyright: 'array', style: 'array', meta: 'array' },
      rating: 'string',
    }],
    failures: [failure],
  }),
  contract(embeddingTask, { items: [imageItem] }, {
    embeddings: [{ postId: 'number', embedding: 'string' }],
    failures: [failure],
  }),
  contract(dedupTask, {
    matrixPath: 'string',
    count: 'number',
    dim: 'number',
    threshold: 'number',
    chunkSize: 'number',
    maxPerRow: 'number',
  }, {
    pairs: 'array',
  }),
  contract(textEmbedTask, { prompt: 'string' }, {
    embedding: 'string',
    scale: 'number',
    bias: 'number',
  }),
  contract(lpipsVerifyTask, {
    pairs: [{ a: imageItem, b: imageItem }],
  }, {
    results: [{ a: 'number', b: 'number', distance: 'number' }],
    failures: [{ a: 'number', b: 'number', error: 'string' }],
  }),
  contract(thumbnailTask, { originalPath: 'string', thumbnailPath: 'string' }, {
    ok: 'boolean',
    error: 'string',
  }),
  contract(rotateTask, { originalPath: 'string', thumbnailPath: 'string', clockwise: 'boolean' }, {
    sha256: 'string',
    size: 'number',
    width: 'number',
    height: 'number',
    arthash: 'string',
  }),
  contract(captionTask, { imagePath: 'string' }, { configured: 'boolean', caption: 'string' }),
  contract(basicsTask, {
    items: [{
      postId: 'number',
      path: 'string',
      thumbnailPath: 'string',
      hasSha256: 'boolean',
      hasArthash: 'boolean',
      hasColor: 'boolean',
    }],
  }, {
    rows: [{
      postId: 'number',
      sha256: 'string',
      size: 'number',
      arthash: 'string',
      width: 'number',
      height: 'number',
      colors: 'array',
      dominantLab: 'array',
      colorError: 'string',
    }],
    failures: [failure],
  }),
  contract(danbooruListTask, {
    tags: 'string',
    limit: 'number',
    fullScan: 'boolean',
    importedIds: 'array',
    filePathStr: 'string',
    typeToGroupId: 'record',
  }, {
    items: [danbooruItem],
    stats: {
      total: 'number',
      withUrl: 'number',
      filtered: 'number',
      earlyStopped: 'boolean',
    },
  }),
  contract(danbooruDownloadTask, {
    items: [{ fileUrl: 'string', fileSize: 'number', fileName: 'string', extension: 'string' }],
    saveDir: 'string',
  }, {
    landed: 'array',
    downloaded: 'number',
    skipped: 'number',
    failed: 'number',
  }),
  contract(urlScanTask, { url: 'string' }, {
    fetched: 'number',
    filePath: 'string',
    items: [galleryItem],
  }),
  contract(urlDownloadTask, {
    items: [galleryItem],
    saveDir: 'string',
    filePathStr: 'string',
    typeToGroupId: 'record',
  }, {
    rows: [postRow],
    downloaded: 'number',
    failed: 'number',
  }),
]

// ─── 运行时比对 ──────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 `value` 与规格逐层比对，返回所有不一致处（空数组 = 一致）。 */
function shapeErrors(value: unknown, shape: AnyShape, at: string): string[] {
  if (typeof shape === 'string') {
    if (value === null)
      return []
    if (shape === 'record')
      return isObject(value) ? [] : [`${at}: 应为对象映射`]
    if (shape === 'array')
      return Array.isArray(value) ? [] : [`${at}: 应为数组`]
    return typeof value === shape ? [] : [`${at}: 应为 ${shape}，实际是 ${typeof value}`]
  }
  if (Array.isArray(shape)) {
    // 空数组什么都证明不了 —— fixture 里每个对象数组至少放一个元素。
    if (!Array.isArray(value) || value.length === 0)
      return [`${at}: 应为非空数组`]
    return value.flatMap((v, i) => shapeErrors(v, shape[0] as AnyShape, `${at}[${i}]`))
  }
  if (!isObject(value))
    return [`${at}: 应为对象`]
  const spec = shape as { readonly [key: string]: AnyShape }
  const want = Object.keys(spec)
  const got = Object.keys(value)
  return [
    ...want.filter(k => !(k in value)).map(k => `${at}.${k}: fixture 缺这个字段`),
    ...got.filter(k => !(k in spec)).map(k => `${at}.${k}: 接口里没有这个字段`),
    ...want.filter(k => k in value).flatMap(k => shapeErrors(value[k], spec[k]!, `${at}.${k}`)),
  ]
}

interface Fixture {
  queue: string
  payload: unknown
  result: unknown
}

function readFixture(name: string): Fixture {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'tasks', `${name}.json`), 'utf8')) as Fixture
}

// ─── 测试 ──────────────────────────────────────────────────────────────

describe('任务契约 fixture', () => {
  it('每个任务恰好一份 fixture，没有多余的', () => {
    const files = readdirSync(path.join(FIXTURES, 'tasks'))
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -'.json'.length))
      .sort()
    expect(files).toEqual(CONTRACTS.map(c => c.task.name).sort())
    expect(files).toEqual(Object.keys(TASK_QUEUES).sort())
  })

  describe.each(CONTRACTS.map(c => [c.task.name, c] as const))('%s', (name, c) => {
    const fixture = readFixture(name)

    it('queue 与 TASK_QUEUES 一致', () => {
      expect(fixture.queue).toBe(queueOf(c.task))
    })

    it('payload 的键集合与接口完全一致', () => {
      expect(shapeErrors(fixture.payload, c.payload, 'payload')).toEqual([])
    })

    it('result 的键集合与接口完全一致', () => {
      expect(shapeErrors(fixture.result, c.result, 'result')).toEqual([])
    })
  })

  it('SILVA 头的名单与 fixtures/silva-scorers.json 一致（Python 侧对的是同一份）', () => {
    const names = JSON.parse(readFileSync(path.join(FIXTURES, 'silva-scorers.json'), 'utf8')) as string[]
    expect([...names].sort()).toEqual([...SILVA_SCORERS].sort())
  })

  it('比对器自己会红：改名、缺字段、多字段都被抓到', () => {
    const shape: AnyShape = { items: [{ postId: 'number', path: 'string' }] }
    expect(shapeErrors({ items: [{ postId: 1, path: 'a' }] }, shape, 'p')).toEqual([])
    expect(shapeErrors({ items: [{ postId: 1, filePath: 'a' }] }, shape, 'p')).toEqual([
      'p.items[0].path: fixture 缺这个字段',
      'p.items[0].filePath: 接口里没有这个字段',
    ])
    expect(shapeErrors({ items: [] }, shape, 'p')).toEqual(['p.items: 应为非空数组'])
    expect(shapeErrors({ items: [{ postId: '1', path: 'a' }] }, shape, 'p')).toEqual(['p.items[0].postId: 应为 number，实际是 string'])
  })
})
