/**
 * 磁盘与 `posts` 表的对账 —— `POST /v2/cmd/sync-metadata` 背后的那件事。
 *
 * 两步：
 *
 * 1. 走一遍磁盘，和库里的 `(file_path, file_name, extension)` 三元组求差；
 * 2. 少的删、多的建，然后叫醒各个 backfill 循环去填新行的空列 —— 活是 worker
 *    干的，不占着这个请求（这个端点本来就是 fire-and-forget）。
 */
import type { getDb } from './db.js'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pictoriaDir, targetDir } from './paths.js'
import { deletePostFiles } from './post-files.js'

type SqliteHandle = ReturnType<typeof getDb>['sqlite']
type Log = Pick<Console, 'info' | 'warn'>

/** `(相对目录, 文件名主干, 扩展名)`，和 posts 表的三元组一一对应。 */
export type FileTriple = [string, string, string]

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

export async function scanLibrary(root: string, { log = console }: { log?: Log } = {}): Promise<ScanResult> {
  const out: FileTriple[] = []
  const failedDirs: string[] = []
  // 边走边建新表，走完整体替换。缓存只按 mtime 判新旧，自己发现不了"这个目录没了"；
  // 而"本轮走到过的目录"恰好就是"本轮该留的缓存"，所以不需要额外记一份再回头清扫 ——
  // 没走到的目录天然不在新表里。（`syncMetadata` 用 `running` 保证不并发。）
  const next: ScanCache = new Map()

  // 读不动的目录：记下它的相对路径并保留它上一轮的缓存内容。保留是重点 —— 网络盘
  // 抖一下就把那棵子树的文件从结果里抹掉，而"结果里没有"正是删除判定的输入。
  // 记路径同样是重点：删除判定按子树跳过它们，只记个数的话保护范围只能是全库。
  const fail = (dirPath: string, relDir: string, what: string, err: unknown): void => {
    failedDirs.push(relDir)
    log.warn(`[sync] 跳过 ${dirPath}（${what} 失败）：${String(err)}`)
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

/** 一次同步只跑一个。第二次调用不排队而是记一笔补跑，见 `startSync`。 */
let running = false

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
  { log = console, allowMassDelete = false }: { log?: Log, allowMassDelete?: boolean } = {},
): Promise<SyncResult> {
  const root = targetDir()
  const t0 = Date.now()
  const { files: onDisk, failedDirs } = await scanLibrary(root, { log })
  log.info(`[sync] 扫描 ${onDisk.length} 个文件，${((Date.now() - t0) / 1000).toFixed(2)}s`)

  const key = (t: FileTriple) => `${t[0]}\0${t[1]}\0${t[2]}`
  const dbRows = sqlite
    .prepare<[], { id: number, file_path: string, file_name: string, extension: string }>(
      'SELECT id, file_path, file_name, extension FROM posts',
    )
    .all()
  const dbByKey = new Map(dbRows.map(r => [key([r.file_path, r.file_name, r.extension]), r]))
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
  }
  log.info(`[sync] 库里 ${dbByKey.size} 个文件，磁盘上 ${diskKeys.size} 个`)

  const deleted: Array<{ id: number, dir: string }> = []
  for (const [k, row] of dbByKey) {
    if (!diskKeys.has(k))
      deleted.push({ id: row.id, dir: row.file_path })
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
      `[sync] ${failedDirs.length} 个目录读不动，其下 ${shielded.length} 个删除判定跳过`
      + '（扫描不到的子树里"没看见"不等于"已删除"，删了会连原图一起抹掉）',
    )
  }
  let removed = 0
  if (deletable.length) {
    if (massDelete) {
      skippedDeletes += deletable.length
      log.warn(
        `[sync] ${deletable.length}/${dbByKey.size} 行被判为已删除，超过 ${MASS_DELETE_RATIO * 100}% —— 跳过。`
        + '确认是真的删了这么多，就带 allow_mass_delete=1 重新触发 POST /v2/cmd/sync-metadata'
        + '（或设 PICTORIA_SYNC_ALLOW_MASS_DELETE=1，进程级）。',
      )
    }
    else {
      log.info(`[sync] 检测到 ${deletable.length} 个文件已被删除`)
      deletePostFiles(sqlite, deletable.map(d => d.id))
      removed = deletable.length
    }
  }

  if (newTriples.length) {
    log.info(`[sync] 检测到 ${newTriples.length} 个新文件`)
    const ins = sqlite.prepare('INSERT INTO posts(file_path, file_name, extension) VALUES (?, ?, ?)')
    sqlite.transaction(() => {
      for (const t of newTriples) ins.run(t[0], t[1], t[2])
    })()
  }

  return {
    onDisk: diskKeys.size,
    inDb: dbByKey.size,
    removed,
    added: newTriples.length,
    skippedDeletes,
  }
}

/**
 * 一次同步跑完之后要不要再跑一次。
 *
 * 在跑的时候来的触发不能直接丢：拷进来一批图触发了同步，同步还没跑完你删掉一张，
 * 那次删除的事件就没了，库里的行要等下一次 10 分钟轮询才消失（Python 侧继承来的
 * 毛病）。所以记一笔"跑完再来一次"。
 *
 * ⚠️ 这个标志属于 `startSync` 而不是某一个调用方。它原来长在 `startAutoSync` 的
 * 闭包里，只有 watch/poll 那条路消费得到它 —— 而 `startSync` 另有两个调用方
 * （`/v2/cmd/sync-metadata` 和 danbooru 导入结束时），用户手工触发的那次扫描把
 * 标志顶起来之后没人管，于是补跑不发生、白等 10 分钟，还多跑一次全扫。
 */
let pendingRerun = false

/**
 * 加了忙检查的一次性入口；忙的话返回 false，调用方据此报"已在跑"。
 *
 * `allowMassDelete` 只对**这一次**生效：它表达的是"用户确认了这批删除是真的"，
 * 而补跑（`pendingRerun`）响应的是之后进来的新变化，不继承这份确认。
 */
export function startSync(
  sqlite: SqliteHandle,
  onDone: (r: SyncResult) => void,
  { log = console, allowMassDelete = false }: { log?: Log, allowMassDelete?: boolean } = {},
): boolean {
  if (running) {
    pendingRerun = true
    return false
  }
  running = true
  // fire-and-forget：请求立刻返回，扫描在后台跑。
  void (async () => {
    try {
      onDone(await syncMetadata(sqlite, { log, allowMassDelete }))
    }
    catch (err) {
      log.warn(`[sync] 失败：${String(err)}`)
    }
    finally {
      running = false
    }
    if (pendingRerun) {
      pendingRerun = false
      // 下一个 tick，别在自己的 finally 里递归重入
      setImmediate(() => {
        log.info('[sync] 上一轮跑的时候还有变化进来，补一次')
        startSync(sqlite, onDone, { log })
      })
    }
  })()
  return true
}


/**
 * 两个自动触发对账的东西 —— 形状承自已删除的 `app.py::_spawn_backfill_poller`。
 *
 * **文件监视**在最后一个事件之后 1.5 秒开跑：批量拷贝 / rsync 会在极短时间里打出
 * 上千个事件，防抖把它们收成一次同步。**轮询**是安全网，给监视器漏事件的平台和
 * 文件系统兜底（网络盘尤其）。两个都要，缺一个就会有"图进来了但半天不出现"的情况。
 */
const WATCH_DEBOUNCE_MS = 1500
const POLL_INTERVAL_MS = 600_000

export interface AutoSyncHandle {
  stop: () => void
}

export function startAutoSync(
  sqlite: SqliteHandle,
  onSynced: () => void,
  { log = console }: { log?: Log } = {},
): AutoSyncHandle {
  const root = targetDir()
  // 同步进行中又来了事件时的补跑由 `startSync` 自己负责（见那边的 `pendingRerun`），
  // 这里只管触发。
  const fire = (label: string) => {
    startSync(sqlite, (r) => {
      if (r.added || r.removed)
        log.info(`[sync/${label}] 新增 ${r.added}，删除 ${r.removed}`)
      if (r.skippedDeletes)
        log.warn(`[sync/${label}] 有 ${r.skippedDeletes} 个删除判定被跳过`)
      onSynced()
    }, { log })
  }

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
      debounce = setTimeout(() => fire('watch'), WATCH_DEBOUNCE_MS)
    })
  }
  catch (err) {
    log.warn(`[sync] 文件监视启动失败，只靠轮询：${String(err)}`)
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
