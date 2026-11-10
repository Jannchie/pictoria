/**
 * 磁盘与 `posts` 表的对账 —— `POST /v2/cmd/sync-metadata` 背后的那件事。
 *
 * 两步：
 *
 * 1. 走一遍磁盘，和库里的 `(file_path, file_name, extension)` 三元组求差；
 * 2. 少的删、多的建。建行的 `insertPostTriples` 自己叫醒各个 backfill 循环去填新行的
 *    空列（`@pictoria/db` 的 `repending.ts`）—— 活是 worker 干的，不占着这个请求（这个
 *    端点本来就是 fire-and-forget）。
 */
import { clearMissingFiles, insertPostTriples, listMissingFilePosts, listPostTriples, type PostTriple, type PostTripleRow, type SqliteHandle } from '@pictoria/db'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { coalesceWithCooldown, yieldToEventLoop } from './event-loop.js'
import { createLogger, type Log } from './log.js'
import { pictoriaDir, postAbsPath, targetDir } from './paths.js'
import { deletePostFiles } from './post-files.js'

const defaultLog = createLogger('sync')

/** `(相对目录, 文件名主干, 扩展名)`，和 posts 表的三元组一一对应。 */
export type FileTriple = PostTriple

/** 目录绝对路径 → `(mtime_ns, 直接子文件)`。跨调用复用。 */
type ScanCache = Map<string, { mtimeNs: bigint, files: FileTriple[] }>

let scanCache: ScanCache = new Map()

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  // `dot > 0` 而不是 `>= 0`：`.gitignore` 的主干是 `.gitignore`，不是空串。
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, '']
}

/**
 * 递归走 `root`，返回 `(相对路径, 主干, 扩展名)` 三元组。
 *
 * ⚠️ **异步**，而且必须是。同步版本实测让一次 22 万文件的扫描把事件循环占住
 * 2.5 秒 —— 期间连这个请求自己的 201 都发不出去，整个服务停摆。`await` 让每个
 * 目录之间都有让出点（Python 侧用 `asyncio.to_thread` 达到同样效果）。
 *
 * 跳过顶层任何以 `.` 开头的项（`.pictoria` 工作目录），以及任何位置的 `*.part`
 * —— 那是下载器的在途临时文件，不能被登记成 post。
 *
 * 带 mtime 缓存：目录 mtime 没变就直接复用上次的直接子文件列表，但**仍然递归**
 * 进子目录 —— NTFS / ext4 上父目录的 mtime 只反映直接子项，深层的改动不会冒泡。
 * 22 万文件的库上，这让第二次之后的扫描从几秒降到亚秒级。
 *
 * ⚠️ 读不动的目录会被**记下来**（`failedDirs`），不能只是跳过。一个
 * `stat` / `readdir` 失败的子树在结果里等于"这底下一个文件都没有"，而调用方拿这个
 * 差集去删 —— 库放在没挂上的外置盘 / 网络盘上时，那是整库的行加上原图被抹掉。
 * 删除是不可逆的，所以扫描不完整这件事必须传得出去，而且要带上**是哪些目录**：
 * 只记个数的话，一个永远读不动的目录（NAS 上的 System Volume Information、ACL
 * 受限的文件夹）会让全库的删除对账永久失效，健康目录里的删除也永远清不掉。
 */
export interface ScanResult {
  files: FileTriple[]
  /** 读不动的目录的库内相对路径（根是 `'.'`）。非空意味着这次扫描不完整，删除判定按子树跳过它们。 */
  failedDirs: string[]
}

export async function scanLibrary(root: string, { log = defaultLog }: { log?: Log } = {}): Promise<ScanResult> {
  const out: FileTriple[] = []
  const failedDirs: string[] = []
  // 边走边建新表，走完整体替换。缓存只按 mtime 判新旧，自己发现不了"这个目录没了"；
  // 而"本轮走到过的目录"恰好就是"本轮该留的缓存"，所以不需要额外记一份再回头清扫 ——
  // 没走到的目录天然不在新表里。（`startSync` 的单飞状态保证不并发。）
  const next: ScanCache = new Map()

  // 读不动的目录：记下它的相对路径并保留它上一轮的缓存内容。保留是重点 —— 网络盘
  // 抖一下就把那棵子树的文件从结果里抹掉，而"结果里没有"正是删除判定的输入。
  // 记路径同样是重点：删除判定按子树跳过它们，只记个数的话保护范围只能是全库。
  const fail = (dirPath: string, relDir: string, what: string, err: unknown): void => {
    failedDirs.push(relDir)
    log.warn(`跳过 ${dirPath}（${what} 失败）：${String(err)}`)
    const cached = scanCache.get(dirPath)
    if (cached) {
      out.push(...cached.files)
      next.set(dirPath, cached)
    }
  }

  async function walk(dirPath: string, relDir: string, isTop: boolean): Promise<void> {
    let mtimeNs: bigint
    try {
      mtimeNs = (await fs.promises.stat(dirPath, { bigint: true })).mtimeNs
    }
    catch (err) {
      fail(dirPath, relDir, 'stat', err)
      return
    }

    const cached = scanCache.get(dirPath)
    const reuse = cached !== undefined && cached.mtimeNs === mtimeNs
    const subdirs: Array<[string, string]> = []
    const direct: FileTriple[] = []

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    }
    catch (err) {
      fail(dirPath, relDir, 'readdir', err)
      return
    }

    for (const entry of entries) {
      if (isTop && entry.name.startsWith('.'))
        continue
      if (entry.isDirectory()) {
        subdirs.push([path.join(dirPath, entry.name), relDir === '.' ? entry.name : `${relDir}/${entry.name}`])
        continue
      }
      // 目录 mtime 没变时不必再看文件 —— 但目录项还是要列一遍才能拿到子目录。
      if (reuse || !entry.isFile())
        continue
      if (entry.name.endsWith('.part'))
        continue
      const [stem, ext] = splitName(entry.name)
      direct.push([relDir, stem, ext])
    }

    if (reuse) {
      out.push(...cached.files)
      next.set(dirPath, cached)
    }
    else {
      out.push(...direct)
      next.set(dirPath, { mtimeNs, files: direct })
    }

    for (const [subPath, subRel] of subdirs) await walk(subPath, subRel, false)
  }

  await walk(root, '.', true)
  scanCache = next
  return { files: out, failedDirs }
}

export interface SyncResult {
  onDisk: number
  inDb: number
  removed: number
  added: number
  /** 判定为已删除、但因为扫描不完整或超出安全阈值而**没有**删的行数。 */
  skippedDeletes: number
}

/**
 * 一次同步最多允许删掉库里多大比例的行。
 *
 * 删除走的是 `deletePostFiles` —— 连 DB 行带**原图**一起 unlink，不可逆。而判定
 * 依据只是"这次扫描没看见它"，任何让扫描少看见文件的原因（盘没挂上、根目录被换、
 * 权限变了）都会一次性把整库判成已删除。
 *
 * 一次删掉库里一半以上是人干的事，不是自动对账该干的：真删了那么多就带
 * `allow_mass_delete=1` 手工触发 `POST /v2/cmd/sync-metadata`（按次放行，只对
 * 这一次生效），或者设 `PICTORIA_SYNC_ALLOW_MASS_DELETE=1`（进程级，连自动轮询
 * 一起放行 —— 只适合无人值守的批量整理，用完记得取消）。
 * 小库（不足 `MASS_DELETE_FLOOR` 行）不设限 —— 那里"删掉一半"是三张图的事。
 */
const MASS_DELETE_RATIO = 0.5
const MASS_DELETE_FLOOR = 100

/** diff 循环每处理多少项让出一次事件循环。1 万项约几毫秒。 */
const YIELD_EVERY = 10_000

/**
 * 对账一次。**不要直接调**：并发控制和补跑都在 `startSync` 里。
 *
 * 删掉的文件连带删 DB 行、原图和缩略图；unlink 是尽力而为 —— 它出现在"删掉"这一
 * 侧，本来最常见的原因就是文件已经没了。
 *
 * 两道闸门挡在删除前面（新增照常，它不可逆的那一半是删）：
 *
 * 1. 读不动的目录**按子树**豁免 —— 它底下的行不参与删除判定，其余目录照常对账。
 *    按子树而不是全库：一个永久读不动的目录（NAS 的 System Volume Information、
 *    ACL 受限的文件夹）如果冻结全部删除，健康目录里的删除就永远清不掉，而且没有
 *    任何逃生通道。库根本身读不动时子树就是全库，行为和整体冻结一致。
 * 2. 剩下可删的量不能超过 `MASS_DELETE_RATIO`，除非 `allowMassDelete`（手动端点
 *    按次放行）或环境变量放行。
 */
export async function syncMetadata(
  sqlite: SqliteHandle,
  { log = defaultLog, allowMassDelete = false, scan = scanLibrary, yieldEvery = YIELD_EVERY }: {
    log?: Log
    allowMassDelete?: boolean
    /** 测试缝：在扫描前后插入并发写入。 */
    scan?: typeof scanLibrary
    /** 测试缝：diff 循环每处理多少项让出一次。 */
    yieldEvery?: number
  } = {},
): Promise<SyncResult> {
  const root = targetDir()
  // ⚠️ **先读库、再扫盘**，顺序不能反。删除判定是"库里有、盘上没看见"，而扫描是异步的、
  // 要走好几秒：先扫后读的话，某个目录被 readdir 之后才落地的一张上传图（上传端点先建行
  // 再写文件）在库里有、在扫描结果里没有，于是被当成已删除 —— 连刚写下的原图一起 unlink。
  // 先读库，删除判定就只涉及**扫描开始前**已经存在的行，而它们的文件在扫描开始前也已经
  // 在盘上了。代价是反方向：读库之后才落地的文件会被再登记一次，由唯一索引 +
  // `INSERT OR IGNORE`（`insertPostTriples`）吸收。
  const key = (t: FileTriple) => `${t[0]}\0${t[1]}\0${t[2]}`
  // 下面三趟各走 31 万项（拼 key、建 Map / Set、求差），一趟就是几百毫秒的纯 JS ——
  // sync 在上传期间频繁地跑，不切开的话每次都让前端卡一下。快照已经取好，中间让出
  // 不会把并发写入卷进删除判定（见上一段）。
  // 判断是同步的，只在真要让出时才 await —— 每项都 await 一个 async 函数的话，
  // 93 万项就是 93 万个 Promise。
  let sinceYield = 0
  const due = () => {
    if (++sinceYield < yieldEvery)
      return false
    sinceYield = 0
    return true
  }
  const dbByKey = new Map<string, PostTripleRow>()
  for (const r of listPostTriples(sqlite)) {
    dbByKey.set(key([r.file_path, r.file_name, r.extension]), r)
    if (due())
      await yieldToEventLoop()
  }
  const t0 = Date.now()
  const { files: onDisk, failedDirs } = await scan(root, { log })
  log.info(`扫描 ${onDisk.length} 个文件，${((Date.now() - t0) / 1000).toFixed(2)}s`)
  // 一趟走完 22.3 万个文件：key 只拼一次，两个产物同时出来。分成 `map` + `filter`
  // 会多留一个和 `onDisk` 靠下标对齐的平行数组 —— 以后谁给 `onDisk` 加一次
  // filter/sort 就会静默错位。
  const diskKeys = new Set<string>()
  const newTriples: FileTriple[] = []
  for (const t of onDisk) {
    const k = key(t)
    diskKeys.add(k)
    if (!dbByKey.has(k))
      newTriples.push(t)
    if (due())
      await yieldToEventLoop()
  }
  log.info(`库里 ${dbByKey.size} 个文件，磁盘上 ${diskKeys.size} 个`)

  const deleted: Array<{ id: number, dir: string }> = []
  for (const [k, row] of dbByKey) {
    if (!diskKeys.has(k))
      deleted.push({ id: row.id, dir: row.file_path })
    if (due())
      await yieldToEventLoop()
  }

  // 闸门一：读不动的目录按子树豁免。`'.'`（库根读不动）盖住一切。
  // （failedDirs 为空时 `.some()` 恒为 false，全部落进 deletable，不需要专门分支。）
  const failedPrefixes = failedDirs.map(f => `${f}/`)
  const underFailed = (dir: string): boolean =>
    failedDirs.some((f, i) => f === '.' || dir === f || dir.startsWith(failedPrefixes[i]!))
  const shielded: typeof deleted = []
  const deletable: typeof deleted = []
  for (const d of deleted)
    (underFailed(d.dir) ? shielded : deletable).push(d)

  // 闸门二：可删的量超比例就整体拒绝 —— 半库消失是人干的事，得由人确认。
  const allowMass = allowMassDelete || process.env.PICTORIA_SYNC_ALLOW_MASS_DELETE === '1'
  const massDelete = !allowMass
    && dbByKey.size >= MASS_DELETE_FLOOR
    && deletable.length / dbByKey.size > MASS_DELETE_RATIO

  let skippedDeletes = 0
  if (shielded.length) {
    skippedDeletes += shielded.length
    log.warn(
      `${failedDirs.length} 个目录读不动，其下 ${shielded.length} 个删除判定跳过`
      + '（扫描不到的子树里"没看见"不等于"已删除"，删了会连原图一起抹掉）',
    )
  }
  let removed = 0
  if (deletable.length) {
    if (massDelete) {
      skippedDeletes += deletable.length
      log.warn(
        `${deletable.length}/${dbByKey.size} 行被判为已删除，超过 ${MASS_DELETE_RATIO * 100}% —— 跳过。`
        + '确认是真的删了这么多，就带 allow_mass_delete=1 重新触发 POST /v2/cmd/sync-metadata'
        + '（或设 PICTORIA_SYNC_ALLOW_MASS_DELETE=1，进程级）。',
      )
    }
    else {
      log.info(`检测到 ${deletable.length} 个文件已被删除`)
      // 分块、块间让出事件循环（见 `post-files.ts`）：一次删几万行不该让 API 停摆。
      await deletePostFiles(sqlite, deletable.map(d => d.id))
      removed = deletable.length
    }
  }

  if (newTriples.length) {
    log.info(`检测到 ${newTriples.length} 个新文件`)
    insertPostTriples(sqlite, newTriples)
  }

  await restoreReturnedFiles(sqlite, log)

  return {
    onDisk: diskKeys.size,
    inDb: dbByKey.size,
    removed,
    added: newTriples.length,
    skippedDeletes,
  }
}

/**
 * 调度器提交前发现文件不在盘上的 post 会被记成"文件不在盘上"黑名单（`scheduler.ts` 的
 * `runBatch`，让出队首）。文件回来了（外置盘重新挂上、移动完成）就在这里清掉，并让对应
 * 循环退水位重新捡起它们（`clearMissingFiles` 发重新待办信号）。行数是这类异常的量级，
 * 逐个 access 一次不贵。文件真的没了的那些，上面的删除判定会连行带黑名单一起删掉。
 */
export async function restoreReturnedFiles(sqlite: SqliteHandle, log: Log = defaultLog): Promise<number> {
  const missing = listMissingFilePosts(sqlite)
  if (!missing.length)
    return 0
  const back = (await Promise.all(missing.map(async (m) => {
    try {
      await fs.promises.access(postAbsPath(m.relPath))
      return m.postId
    }
    catch {
      return null
    }
  }))).filter((id): id is number => id !== null)
  if (!back.length)
    return 0
  clearMissingFiles(sqlite, back)
  log.info(`${back.length} 个之前不在盘上的文件回来了，重新排进 backfill`)
  return back.length
}

/**
 * 同步的单飞状态：要么没在跑，要么正在跑一次、外加"跑完要不要再来一次"。
 *
 * 在跑的时候来的触发不能直接丢：拷进来一批图触发了同步，同步还没跑完你删掉一张，
 * 那次删除的事件就没了，库里的行要等下一次 10 分钟轮询才消失（Python 侧继承来的
 * 毛病）。所以记一笔 `rerun`。
 *
 * ⚠️ 这份状态属于 `startSync` 而不是某一个调用方。补跑标志原来长在 `startAutoSync` 的
 * 闭包里，只有 watch/poll 那条路消费得到它 —— 而 `startSync` 另有两个调用方
 * （`/v2/cmd/sync-metadata` 和 URL 导入结束时），用户手工触发的那次扫描把
 * 标志顶起来之后没人管，于是补跑不发生、白等 10 分钟，还多跑一次全扫。
 *
 * `run` 是正在跑的那一次；文件监视的冷却靠它知道"这一轮什么时候结束"（`syncSettled`）。
 */
interface RunningSync { kind: 'running', run: Promise<void>, rerun: boolean }
type SyncState = { kind: 'idle' } | RunningSync

let syncState: SyncState = { kind: 'idle' }

/** 等正在跑的同步（连同已经排上的补跑）结束；没在跑就立即返回。 */
export async function syncSettled(): Promise<void> {
  while (syncState.kind === 'running')
    await syncState.run
}

/**
 * `startSync` 的结果：`started` = 这次调用开了一轮；`queued` = 已经有一轮在跑，记了一笔
 * 补跑 —— 两种情况下"调用之前落到磁盘上的变化"都会被某一轮同步看到。
 */
export type SyncStart = 'started' | 'queued'

/**
 * 加了单飞的一次性入口：没在跑就开一轮，在跑就排一次补跑（见 `SyncState`）。
 *
 * `allowMassDelete` 只对**这一次**生效：它表达的是"用户确认了这批删除是真的"，
 * 而补跑响应的是之后进来的新变化，不继承这份确认。
 */
export function startSync(
  sqlite: SqliteHandle,
  onDone?: (r: SyncResult) => void,
  { log = defaultLog, allowMassDelete = false }: { log?: Log, allowMassDelete?: boolean } = {},
): SyncStart {
  if (syncState.kind === 'running') {
    syncState.rerun = true
    return 'queued'
  }
  // fire-and-forget：请求立刻返回，扫描在后台跑。先登记状态再开跑 —— 下面的 async
  // 函数在第一个 await 之前是同步执行的，那期间再来的调用也得看到"在跑"。
  const state: RunningSync = { kind: 'running', rerun: false, run: Promise.resolve() }
  syncState = state
  state.run = (async () => {
    try {
      const result = await syncMetadata(sqlite, { log, allowMassDelete })
      onDone?.(result)
    }
    catch (err) {
      log.warn(`失败：${String(err)}`)
    }
    finally {
      syncState = { kind: 'idle' }
    }
    // 同步地接上补跑：中间不留空档，否则空档里进来的触发会开一轮，补跑再来时看到
    // "在跑"又记一笔，平白多扫一遍全库。新一轮从 `syncMetadata` 的第一个 await 起
    // 就交出控制权，所以这里不是递归加深。
    if (state.rerun) {
      log.info('上一轮跑的时候还有变化进来，补一次')
      startSync(sqlite, onDone, { log })
    }
  })()
  return 'started'
}


/**
 * 两个自动触发对账的东西 —— 形状承自已删除的 `app.py::_spawn_backfill_poller`。
 *
 * **文件监视**在最后一个事件之后 1.5 秒开跑：批量拷贝 / rsync 会在极短时间里打出
 * 上千个事件，防抖把它们收成一次同步。**轮询**是安全网，给监视器漏事件的平台和
 * 文件系统兜底（网络盘尤其）。两个都要，缺一个就会有"图进来了但半天不出现"的情况。
 */
const WATCH_DEBOUNCE_MS = 1500
/**
 * 文件监视触发的两次同步之间至少隔多久，从上一次**结束**算。
 *
 * 上传端点自己会建行，监视器对它们只是重复劳动；而持续上传时文件事件不断，防抖
 * 每 1.5 秒就放行一次，实测 10 分钟跑了 53 次全库对账。监视器真正要兜的是外部拷进来
 * 的文件，晚半分钟登记无所谓。
 */
const WATCH_COOLDOWN_MS = 30_000
const POLL_INTERVAL_MS = 600_000

export interface AutoSyncHandle {
  stop: () => void
}

export function startAutoSync(
  sqlite: SqliteHandle,
  { log = defaultLog }: { log?: Log } = {},
): AutoSyncHandle {
  const root = targetDir()
  // 同步进行中又来了事件时的补跑由 `startSync` 自己负责（见那边的 `SyncState`），
  // 这里只管触发。
  const fire = (label: string) => {
    startSync(sqlite, (r) => {
      if (r.added || r.removed)
        log.info(`${label}：新增 ${r.added}，删除 ${r.removed}`)
      if (r.skippedDeletes)
        log.warn(`${label}：有 ${r.skippedDeletes} 个删除判定被跳过`)
    }, { log })
  }

  // 防抖之后再过一道冷却：等这一轮真的跑完（`syncSettled`）才开始计时。
  const requestWatchSync = coalesceWithCooldown(async () => {
    fire('watch')
    await syncSettled()
  }, WATCH_COOLDOWN_MS)

  let debounce: NodeJS.Timeout | undefined
  let watcher: fs.FSWatcher | undefined
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (!filename)
        return
      // 不对自己写的缩略图 / sqlite 起反应 —— 它们就在 .pictoria 下面，
      // 不排除的话同步会自己触发自己。
      if (path.resolve(root, filename.toString()).startsWith(pictoriaDir()))
        return
      clearTimeout(debounce)
      debounce = setTimeout(requestWatchSync, WATCH_DEBOUNCE_MS)
    })
  }
  catch (err) {
    log.warn(`文件监视启动失败，只靠轮询：${String(err)}`)
  }

  // 启动时先对一次账：服务没在跑的时候进来的文件，只有这一下能发现它们
  // （形状承自已退役的 Python 侧的 `_run_sync_once("Startup")`）。
  fire('startup')

  const timer = setInterval(() => fire('poll'), POLL_INTERVAL_MS)
  // 别让这个定时器把进程钉在事件循环里
  timer.unref?.()

  return {
    stop: () => {
      clearTimeout(debounce)
      clearInterval(timer)
      watcher?.close()
    },
  }
}
