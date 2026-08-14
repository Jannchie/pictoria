/**
 * 进程里所有"东西在哪"的单一出处。
 *
 * 这些路径之前散在四个文件里各算一遍（`db.ts`、`tasks.ts`、`scheduler.ts`、
 * `routes/folders.ts`），默认值 `server/illustration/images` 就写死了四份。它们必须
 * 一致：API 和 cairnq 一旦解析到不同目录，提交的任务会安静地躺在另一个
 * `tasks.sqlite` 里直到超时，不报错，只是不动。
 *
 * 只覆盖 TS 侧。Python worker 有自己的一份（`worker/handlers.py` 的 `library_root()` /
 * `pictoria_dir()` / `thumbnails_root()`，根由 `--target_dir` 传入），逐个对应本文件的
 * 导出；两边对不上时同样是静默的，所以改这里就要去那边同步改。
 */
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 仓库根 —— 从本文件位置推出来，而不是靠 `process.cwd()`。
 *
 * cwd 取决于从哪儿启动（`pnpm --filter` 会把 cwd 设成包目录），拿它解析相对路径
 * 会得到 `apps/api/server/illustration/...` 这种不存在的路径。
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** 供其它模块解析仓库内相对路径。 */
export function repoRoot(): string {
  return REPO_ROOT
}

/**
 * 首次调用时算一次，之后复用。
 *
 * 重点是**惰性**而不是缓存：模块顶层求值会在 import 时刻锁死 env，于是任何在
 * import 之后再设环境变量的调用方（测试、脚本）都拿不到自己设的值。缓存只是顺带，
 * `path.resolve` 本来就便宜。
 *
 * ⚠️ 反过来说，第一次调用之后再改 `process.env` 也不会生效。这几个变量只在启动时
 * 读，运行期没人改，所以成立；要在测试里改路径就得在首次调用之前改。
 */
function once(compute: () => string): () => string {
  let cached: string | undefined
  return () => (cached ??= compute())
}

/** 图库绝对根目录 —— worker 也用它校验路径没有逃逸。 */
export const targetDir = once(() =>
  path.resolve(REPO_ROOT, process.env.PICTORIA_TARGET_DIR ?? 'server/illustration/images'),
)

/**
 * 库内的进程私有目录。下面每一样东西都由它派生 —— 这一层单独拿出来，是因为它
 * 不只是"少拼一次字符串"：watcher 的自忽略（`sync.ts`）、删目录的守卫和 walk 的
 * 跳过（`routes/folders.ts`）必须和缩略图、两个 sqlite 落在**同一个**目录，否则
 * 表现是"写缩略图触发自己的 watcher 形成回环"或"删完目录 sync 又把它导回来"，
 * 两种都不报错。
 */
export const pictoriaDir = once(() => path.resolve(targetDir(), '.pictoria'))

/** 缩略图根。TS 侧布局变了只改这里，不然会留下一地孤儿文件（Python worker 有自己的一份）。 */
export const thumbnailsDir = once(() => path.resolve(pictoriaDir(), 'thumbnails'))

/**
 * `DB_PATH` **环境变量**覆盖 `<target_dir>/.pictoria/pictoria.sqlite`。
 *
 * ⚠️ 是环境变量，不是 `.env` —— `apps/api` 不加载任何 dotenv（唯一读 `server/.env`
 * 的是 `s3.ts`，它解析进函数局部变量，从不写回 `process.env`）。写在 `.env` 里静默无效。
 */
export const dbPath = once(() => process.env.DB_PATH ?? path.resolve(pictoriaDir(), 'pictoria.sqlite'))

/**
 * cairnq 的队列库。与 Python worker 的 `tasks_db_path()` 同规则。
 *
 * 覆盖值**锚到仓库根**解析（和 `PICTORIA_TARGET_DIR` 同规则），不能原样交给
 * better-sqlite3：那样相对路径按各自进程的 cwd 解析，而 worker 的 cwd 是
 * `server/`（`pnpm dev:worker` cd 过去的）—— 两个进程会静默打开两个不同的
 * `tasks.sqlite`，每次 `tasks.call` 干等满超时，什么都不报。
 */
export const tasksDbPath = once(() =>
  process.env.TASKS_DB_PATH
    ? path.resolve(REPO_ROOT, process.env.TASKS_DB_PATH)
    : path.resolve(pictoriaDir(), 'tasks.sqlite'),
)

/**
 * dedup 全量重建时落地的临时矩阵。
 *
 * 位置不是随手挑的：worker 的 `_resolve_inside` 只接受图库根之内的路径，而
 * `.pictoria/` 本来就是这个库放自己东西的地方。
 *
 * 每轮一个新名字（`tag` 由 `dedup.ts` 给，pid + 时间戳）。固定名字不行：一次超时
 * 之后 worker 还 mmap 着那个文件，下一轮以同名重开在 Windows 上直接 EBUSY —— 于是
 * 还要认得出上几轮的残留来回收，这就是 `isDedupMatrix` 存在的理由。**造名字和认
 * 名字必须挨着**：分开写两处（一个模板串、一个正则）时改了前缀只会让回收静默停摆，
 * 表现是 `.pictoria/` 下堆积 1 GB 一个的文件，没有任何报错。
 */
const DEDUP_MATRIX_PREFIX = 'dedup-vectors-'
const DEDUP_MATRIX_EXT = '.f32'

export function dedupMatrixPath(tag: string): string {
  return path.resolve(pictoriaDir(), `${DEDUP_MATRIX_PREFIX}${tag}${DEDUP_MATRIX_EXT}`)
}

/**
 * 这个文件名是不是某一轮的临时矩阵 —— `dedup.ts` 拿它回收残留。
 *
 * `dedup-vectors.f32`（无 tag 的旧固定名）也要认：改成带 tag 的命名之前，超时 /
 * 被杀的重建会以这个名字留下约 1 GB 的残留，而删它的旧代码路径已经不在了 ——
 * 不认的话它就永远躺在 `.pictoria/` 里。
 */
export function isDedupMatrix(name: string): boolean {
  return name === 'dedup-vectors.f32'
    || (name.startsWith(DEDUP_MATRIX_PREFIX) && name.endsWith(DEDUP_MATRIX_EXT))
}

/**
 * `target` 是否落在 `root` 之内（含 `root` 自身）。
 *
 * 加分隔符再比前缀：否则 `/lib-secret` 会被判定在 `/lib` 之内。两个调用方
 * （`routes/images.ts` 读文件、`routes/folders.ts` 删目录）都是安全判定，
 * 分成两份实现迟早分叉。
 */
export function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep)
}

/**
 * 把客户端给的相对路径安全地接到 `base` 上，逃出去就返回 `null`。
 *
 * 参数里可能带 `..`，直接 join 会读到任意文件；前导斜杠先剥掉，`/a/b` 和 `a/b`
 * 指的是同一个库内路径。
 */
export function resolveInside(base: string, rel: string): string | null {
  const root = path.resolve(base)
  const candidate = path.resolve(root, rel.replace(/^[/\\]+/, ''))
  return isInside(candidate, root) ? candidate : null
}
