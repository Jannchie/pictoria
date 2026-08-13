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
 * 不在模块顶层求值 —— 那会在 dotenv 之前跑，读到的是没加载 `.env` 的 env。
 * 缓存是安全的：这几个变量只在启动时读，运行期没人改。而调用点是热的
 * （删文件的循环里每个文件调一次，一次全库 sync 就是 22 万次）。
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

/** 与 Python 侧 app.py 的解析规则一致：`DB_PATH` 覆盖 `<target_dir>/.pictoria/`。 */
export const dbPath = once(() => process.env.DB_PATH ?? path.resolve(pictoriaDir(), 'pictoria.sqlite'))

/** cairnq 的队列库。与 Python worker 的 `tasks_db_path()` 同规则。 */
export const tasksDbPath = once(() => process.env.TASKS_DB_PATH ?? path.resolve(pictoriaDir(), 'tasks.sqlite'))

/**
 * dedup 全量重建时落地的临时矩阵。
 *
 * 位置不是随手挑的：worker 的 `_resolve_inside` 只接受图库根之内的路径，而
 * `.pictoria/` 本来就是这个库放自己东西的地方。
 */
export const dedupMatrixPath = once(() => path.resolve(pictoriaDir(), 'dedup-vectors.f32'))

/**
 * SQL 迁移文件所在目录。
 *
 * 仍在 `server/` 下 —— Litestar 退役之后这里已经没有第二个应用者了，但 15 个迁移
 * 是按文件名记在生产库 `_schema_versions` 里的，挪窝要连着改测试固件和 worker 对拍，
 * 不值得和这次退役捆在一起。
 */
export const migrationsDir = once(() => path.resolve(REPO_ROOT, 'server/migrations'))

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
