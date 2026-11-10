/**
 * backfill worker 的**规格** —— 每个 worker 一份，调度循环和单张重算共用。
 *
 * 原来新增一个 worker 要改约 9 处：黑名单键在 `@pictoria/contracts`，待办查询在
 * `packages/db` 里又引用一遍，`scheduler.ts` 写黑名单时再手传一遍；每个 worker 在
 * `scheduler.ts` 里各写一段约 30 行的"取待办 → 组 payload → tasks.call → 落库 →
 * 拉黑 → 打日志 → 返回 {done, failed}"，而 `routes/commands.ts` 的单张重算把其中的
 * "组 payload → 落库"又写了一遍。
 *
 * 现在一个 worker 就是这里的一个 `WorkerSpec`：身份（名字 → 黑名单桶，`@pictoria/db`
 * 的 `failureKey`）、任务（队列由 `@pictoria/contracts` 的 `TASK_QUEUES` 给出）、批大小、
 * 待办扫描、payload 组装、结果落库、拉不拉黑、待办清空后的钩子。
 * `scheduler.ts` 的通用 tick（`runBatch`）和 `routes/commands.ts` 的 `runOneShot`
 * 都只认这份规格，两条路径的差别只剩 key / conflict 策略、拉不拉黑（见 `runOneShot`）和
 * `PersistCtx.interactive`。
 *
 * 放在 apps/api 而不是 `packages/db`：规格要引用 cairnq 的任务定义（`TaskDef`）和
 * 只有 API 层知道的路径（`paths.ts`），而 db 包不该依赖队列。数据那一半（待办查询、
 * 落库函数）仍然在 db 包里，这里只是把它们按 worker 接起来。
 */
import type { CairnQ, TaskDef } from 'cairnq'
import {
  assertTaggerModel,
  BASICS_TASK_BATCH,
  basicsTask,
  EMBEDDING_TASK_BATCH,
  embeddingTask,
  encodeVectorBlob,
  queueOf,
  SILVA_TASK_BATCH,
  silvaTask,
  TAGGER_MODEL,
  TAGGER_TASK_BATCH,
  taggerTask,
  WAIFU_TASK_BATCH,
  waifuTask,
  type BasicsItem,
  type BasicsPayload,
  type BasicsResult,
  type EmbeddingPayload,
  type EmbeddingResult,
  type ImageItem,
  type SilvaPayload,
  type SilvaResult,
  type TaggerBatchResult,
  type TaggerPayload,
  type WaifuPayload,
  type WaifuResult,
  type WorkerFailure,
} from '@pictoria/contracts'
import {
  type AestheticScorerName,
  type BackfillWorker,
  type BasicsPending,
  countBasicsPending,
  countEmbeddingPending,
  countSilvaPending,
  countTaggerPending,
  countWaifuPending,
  embeddingBlobs,
  ensureCanonicalTagGroups,
  listBasicsPending,
  listEmbeddingPending,
  listSilvaPending,
  listTaggerPending,
  listWaifuPending,
  type PendingImage,
  persistTaggerResults,
  SCORERS,
  type SqliteHandle,
  upsertAestheticScores,
  upsertBasics,
  upsertVectors,
  upsertWaifuScores,
} from '@pictoria/db'
import { Buffer } from 'node:buffer'
import { rebuilderFor } from './dedup.js'
import { createLogger, type Log } from './log.js'
import { postAbsPath, thumbnailPathFor } from './paths.js'

const dedupLog = createLogger('dedup')

/** 落库那一步怎么被调用的。 */
export interface PersistCtx {
  /**
   * `true` = 用户点了单张重算（`routes/commands.ts`），`false` = 后台 backfill。
   *
   * 目前只有 tagger 读它：交互路径的 rating **无条件**覆盖（见 `persistTaggerResults`）。
   */
  interactive: boolean
}

/** 一批结果落库之后的账。 */
export interface Persisted {
  /** 计入进度的条数（`queue-status` 的 processed）。 */
  done: number
  /**
   * 这一批的失败，条数也就是计入进度的失败数。backfill 按 `blacklist` 拉黑它们，单张
   * 重算不拉黑（见 `runOneShot`）。
   */
  failures: WorkerFailure[]
  /** 日志"落库 N 条"里的 N，缺省就是 `done`；也是触发 `onDrained` 的依据。 */
  written?: number
  /** 跟在日志计数后面的附注（embedding 的"k 条的 post 已被删除"）。 */
  note?: string
}

/**
 * 一个 backfill worker。`Pending` 是待办扫描出来的一行，`Payload` / `Result` 是
 * cairnq 任务的两端。
 */
export interface WorkerSpec<
  Pending extends { postId: number } = { postId: number },
  Payload extends { items: Array<{ postId: number }> } = { items: Array<{ postId: number }> },
  Result = unknown,
> {
  /** 循环名、水位线键、黑名单桶（经 `failureKey`）—— 全部由它推出。 */
  name: BackfillWorker
  /** 一批多少条。批大小只在 TS 侧定义，worker 收到多少算多少。 */
  batch: number
  /** cairnq 任务；提交到哪个队列由 `queueOf(task)` 定。 */
  task: TaskDef<Payload, Result>
  /**
   * 批次 key 的前缀（`scheduler.ts` 的 `batchKey`），缺省就是 `name`。只有 tagger 设：
   * key 里要不要带模型标识，见 `batchKey` 的 ⚠️。
   */
  keyPrefix?: string
  /** 失败要不要写进 `post_process_failures`。 */
  blacklist: boolean
  /** 水位线以上的待办，按 id 升序，最多 `limit` 条。 */
  listPending: (sqlite: SqliteHandle, limit: number) => Pending[]
  /** 待办计数，按 `chunkRows` 行一块给出 —— 只给状态显示用（`queue-status.ts`）。 */
  countPending: (sqlite: SqliteHandle, chunkRows: number) => Iterable<number>
  /**
   * 待办行 → 任务 payload。`items` 为空表示这一批此刻一个都取不到输入（silva：向量
   * 在两次查询之间被删了），通用 tick 据此返回 `{0, 0}` 而不是提交一个空任务。
   */
  buildPayload: (sqlite: SqliteHandle, pending: Pending[]) => Payload
  /** 结果落库。不碰黑名单：`failures` 交给调用方按 `blacklist` 决定。 */
  persist: (sqlite: SqliteHandle, result: Result, ctx: PersistCtx) => Persisted
  /**
   * 待办清空、且这一轮确实写进过东西（`Persisted.written`）时调用一次。只有 embedding 有
   * （近重复重组）。时机见 `scheduler.ts` 的 `startBackfill`。
   */
  onDrained?: (ctx: { sqlite: SqliteHandle, tasks: Pick<CairnQ, 'call'>, log: Log }) => Promise<void>
  /** `onDrained` 两次之间至少隔多久，从上一次**结束**算；期间的清空合并成一次。缺省 0。 */
  drainCooldownMs?: number
}

/** 只有图片路径的待办 → 任务里的 `ImageItem`。waifu / tagger / embedding 共用。 */
function imageItems(pending: PendingImage[]): ImageItem[] {
  return pending.map(p => ({ postId: p.postId, path: postAbsPath(p.relPath) }))
}

/**
 * SILVA / SILVA-Luna：输入是已存的向量，输出一个标量。按 `SCORERS` 每个打分器一份。
 *
 * 失败不拉黑 —— 能取到向量就应该能打分，所以失败是暂时的/代码的问题，值得下一轮
 * 重试，而不是把这批数据永久跳过（与 Python 侧的 `blacklist_policy = never` 同义）。
 */
function silvaSpec(scorer: AestheticScorerName): WorkerSpec<{ postId: number }, SilvaPayload, SilvaResult> {
  return {
    name: scorer,
    batch: SILVA_TASK_BATCH,
    task: silvaTask,
    blacklist: false,
    listPending: (sqlite, limit) => listSilvaPending(sqlite, scorer, limit).map(postId => ({ postId })),
    countPending: (sqlite, rows) => countSilvaPending(sqlite, scorer, rows),
    buildPayload: (sqlite, pending) => {
      const blobs = embeddingBlobs(sqlite, pending.map(p => p.postId))
      // 待办查询说它们有向量，取的时候却没有 —— 两次查询之间被删了。待办并没有扫空，
      // 所以是空 items（→ `{0, 0}`）而不是"扫空"。
      return {
        scorer,
        items: pending
          .filter(p => blobs.has(p.postId))
          .map(p => ({ postId: p.postId, embedding: encodeVectorBlob(blobs.get(p.postId)!) })),
      }
    },
    persist: (sqlite, result) => {
      upsertAestheticScores(sqlite, scorer, result.scores)
      return { done: result.scores.length, failures: [] }
    },
  }
}

/**
 * waifu：输入是图片本身。
 *
 * 与 silva 的关键差别是失败**要**拉黑：一张读不出来的图不会自己变好，不拉黑的话
 * 待办查询每一轮都会重选它，永远卡在同一批上（Python 侧的
 * `blacklist_policy = "ladder"`）。整批都失败时仍然算"干了活"：黑名单已经写下，
 * 下一轮的待办查询不会再选它们。
 */
export const waifuSpec: WorkerSpec<PendingImage, WaifuPayload, WaifuResult> = {
  name: 'waifu',
  batch: WAIFU_TASK_BATCH,
  task: waifuTask,
  blacklist: true,
  listPending: (sqlite, limit) => listWaifuPending(sqlite, limit),
  countPending: (sqlite, rows) => countWaifuPending(sqlite, rows),
  buildPayload: (_sqlite, pending) => ({ items: imageItems(pending) }),
  persist: (sqlite, result) => {
    upsertWaifuScores(sqlite, result.scores)
    return { done: result.scores.length, failures: result.failures }
  },
}

/**
 * tagger：算在 Python，落库在 TS —— 落库最复杂的一个。
 *
 * worker 只回传标签名和 rating 字符串。哪个标签属于哪个组、rating 能不能覆盖已有值，
 * 都是 schema 的知识，留在拥有 schema 的这一侧。
 *
 * ⚠️ 待办的判据是"标签不是 `TAGGER_MODEL` 打的"，所以**换模型就等于让整库重新排队**
 * （见 `listTaggerPending`）。换的时候要有这个预期：30 万张在一张 3090 上约 18 小时，
 * 期间每一张都是在自己那一个事务里把旧标签换成新的，库不会出现标签空窗。
 *
 * ⚠️ `keyPrefix` 带模型（`tagger:pixai-tagger-v1.0`），理由见 `scheduler.ts` 的
 * `batchKey`：换模型时队列曾把 785 条旧模型的 succeeded 结果原样还了回来。
 *
 * 落库后仍然没有 is_auto 行的那些 —— tagger 产出的标签全部被同名手工标签遮住了。
 * 重跑只会得到同样的结果，所以并进这一批的 `failures`：backfill 里和读不出来的图一样
 * 拉黑，并且**计入失败数**（这一条以前漏算了，状态区的失败数因此偏小）；单张重打标
 * 不拉黑（`runOneShot`），`persistTaggerResults` 发的重新待办信号让 tagger 循环下一轮
 * 把它们捡回来。
 */
export const taggerSpec: WorkerSpec<PendingImage, TaggerPayload, TaggerBatchResult> = {
  name: 'tagger',
  batch: TAGGER_TASK_BATCH,
  task: taggerTask,
  keyPrefix: `tagger:${TAGGER_MODEL}`,
  blacklist: true,
  listPending: (sqlite, limit) => listTaggerPending(sqlite, TAGGER_MODEL, limit),
  countPending: (sqlite, rows) => countTaggerPending(sqlite, TAGGER_MODEL, rows),
  buildPayload: (_sqlite, pending) => ({ items: imageItems(pending) }),
  persist: (sqlite, result, { interactive }) => {
    const model = assertTaggerModel(result.model)
    const groups = ensureCanonicalTagGroups(sqlite)
    // 单张重打标是用户主动点的：rating 无条件覆盖。
    const shadowed = persistTaggerResults(sqlite, result.results, groups, model, { overwriteRating: interactive })
    return {
      done: result.results.length,
      failures: [...result.failures, ...shadowed],
      note: shadowed.length ? `（${shadowed.length} 条被手工标签遮住）` : undefined,
    }
  },
}

/**
 * embedding：SigLIP 2 检索向量。
 *
 * 唯一带**后置钩子**的 worker（`onDrained`），形状承自已删除的
 * `EMBEDDING_WORKER.on_backfill_complete`：写进新向量之后要重建近重复分组，否则新图
 * 永远不会被认成任何一张老图的重复。
 *
 * `written` 用真正写进去的条数，不是回来的条数：算完的这段时间里 post 可能已经被 sync
 * 删掉了，那种会被 upsertVectors 跳过。拿回来的条数计数会让"这一轮写过向量"在一批
 * 全被跳过时也成立，白触发一次分钟级的重组。
 */
export const embeddingSpec: WorkerSpec<PendingImage, EmbeddingPayload, EmbeddingResult> = {
  name: 'embedding',
  batch: EMBEDDING_TASK_BATCH,
  task: embeddingTask,
  blacklist: true,
  listPending: (sqlite, limit) => listEmbeddingPending(sqlite, limit),
  countPending: (sqlite, rows) => countEmbeddingPending(sqlite, rows),
  buildPayload: (_sqlite, pending) => ({ items: imageItems(pending) }),
  persist: (sqlite, result) => {
    const written = upsertVectors(sqlite, result.embeddings.map(e => ({
      postId: e.postId,
      embedding: Buffer.from(e.embedding, 'base64'),
    })))
    return {
      done: result.embeddings.length,
      failures: result.failures,
      written,
      note: written < result.embeddings.length ? `（${result.embeddings.length - written} 条的 post 已被删除）` : undefined,
    }
  },
  // 失败只记一行：重组是尽力而为的，下一次清空还会再来。日志走 dedup 自己的 scope，
  // 不用调度器传进来的那个。
  onDrained: async ({ sqlite, tasks }) => {
    await rebuilderFor(sqlite).rebuild(sqlite, tasks).catch((err: unknown) => dedupLog.error(`重建失败：${String(err)}`))
  },
  // 一次重建是全库的：31 万条向量导出 + GPU 矩阵乘 + 换组，主线程上就是 10 s 以上的 CPU。
  // 上传 / 导入时 embedding 每几十秒清空一次，不合并的话实测 10 分钟跑约 20 轮。新图晚
  // 几分钟被认出是重复图没有代价；重建是全量、确定性的，合并成一轮结果完全一样。
  drainCooldownMs: 5 * 60_000,
}

/**
 * basics：sha256 / arthash / 尺寸 / 调色板 / 主色，外加缩略图。
 *
 * 唯一不碰模型的一个，所以它走 IO 队列（并发 4）而不是 GPU 队列。
 * 失败**要**拉黑，而且有两种：读不出来的文件，以及解码成功但取不出调色板的
 * （退化的纯色图）。后者其余字段照常落库，只有 `dominant_color` 留 NULL ——
 * 而那正是待办查询的条件之一，不拉黑就会每一轮重选它。
 */
export const basicsSpec: WorkerSpec<BasicsPending, BasicsPayload, BasicsResult> = {
  name: 'basics',
  batch: BASICS_TASK_BATCH,
  task: basicsTask,
  blacklist: true,
  listPending: (sqlite, limit) => listBasicsPending(sqlite, limit),
  countPending: (sqlite, rows) => countBasicsPending(sqlite, rows),
  // 原图和缩略图路径都在这一侧算好再交给 worker（和 thumbnail / rotate 任务同一个
  // 出处），布局只在 `paths.ts` 有一份。逐字段拼而不是展开，免得待办行上多出来的
  // 列（`relPath`）混进跨进程契约。
  buildPayload: (_sqlite, pending) => ({
    items: pending.map((p): BasicsItem => ({
      postId: p.postId,
      path: postAbsPath(p.relPath),
      thumbnailPath: thumbnailPathFor(p.relPath),
      hasSha256: p.hasSha256,
      hasArthash: p.hasArthash,
      hasColor: p.hasColor,
    })),
  }),
  persist: (sqlite, result) => {
    upsertBasics(sqlite, result.rows)
    return { done: result.rows.length, failures: result.failures }
  },
}

/** silva 家族，按 `SCORERS` 遍历生成 —— 加一个打分器不用碰这里。 */
export const silvaSpecs = Object.fromEntries(SCORERS.map(s => [s.name, silvaSpec(s.name)])) as Record<AestheticScorerName, ReturnType<typeof silvaSpec>>

/**
 * 全部规格，按 `BACKFILL_WORKERS`（`@pictoria/db`）的启动顺序。`scheduler.test.ts`
 * 断言两边的名字逐个对齐 —— 在 db 里加了名字却忘了在这里加规格，测试先红。
 */
export const BACKFILL_SPECS: readonly WorkerSpec<any, any, any>[] = [
  basicsSpec,
  ...Object.values(silvaSpecs),
  waifuSpec,
  taggerSpec,
  embeddingSpec,
]

/**
 * 单张重算：同一份规格的 payload 组装和落库，换一套提交参数。
 *
 * key 是 `<name>:one:<id>`：用户连点两下拿回的是同一个**在跑的**任务，而不是两次
 * GPU 计算。`maxAttempts: 1` —— 有人在等这个响应，重试只会让他多等一轮。
 *
 * 不写 conflict 就是默认的 `'reuse'`（cairnq ≥ 0.7 状态感知：只复用在跑的，终态一律
 * 重新提交）—— 正是这里要的：这些 key 里只有 post id，而 post 的**内容**会变，成功
 * 结果不能当缓存（转过的图再点"自动标签"必须重算）；失败的更不能复用（0.6 时代那会让
 * 这张图的这个端点永久 500）。backfill 的 `'reuse-succeeded'` 能成立是因为批次 key 列出
 * 全部成员 id，见 `scheduler.ts` 的 `batchKey`。语义细节见 `tasks.ts` 头注。
 *
 * 失败**不拉黑** —— 用户会再点一次，而黑名单会让第二次点击悄悄什么也不做。
 *
 * payload 的 `items` 为空（silva：没有向量）时不提交，返回 `null`。
 */
export async function runOneShot<P extends { postId: number }, Pl extends { items: Array<{ postId: number }> }, R>(
  sqlite: SqliteHandle,
  tasks: CairnQ,
  spec: WorkerSpec<P, Pl, R>,
  pending: P[],
): Promise<R | null> {
  const payload = spec.buildPayload(sqlite, pending)
  if (!payload.items.length)
    return null
  const result = await tasks.call(spec.task, payload, {
    queue: queueOf(spec.task),
    key: `${spec.name}:one:${payload.items.map(i => i.postId).join(',')}`,
    timeoutMs: 300_000,
    maxAttempts: 1,
  })
  spec.persist(sqlite, result, { interactive: true })
  return result
}
