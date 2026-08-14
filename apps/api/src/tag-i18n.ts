/**
 * Tag 显示名的本地化 —— 形状承自已删除的 `services/tag_i18n.py`；数据仍由 `server/scripts/tags/build_tag_i18n.py` 生成。
 *
 * `server/data/tag.<lang>.json` 把 DB 里的 tag 名（danbooru 下划线形式，
 * `green_eyes`）映射到本地化显示名。表由 `scripts/tags/build_tag_i18n.py` 离线生成。
 * 英文不需要表（tag 本身就是英文显示名），所以缺表或缺条目都返回 `null`，调用方
 * 回退到原始名。表按进程首次使用时加载一次（zh-Hans 约 2 MB JSON）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './paths.js'

const DATA_DIR = 'server/data'
/** `tag.<lang>.json`。`lang` 只收字母和连字符 —— 这一条同时就是路径安全边界。 */
const TABLE_FILE = /^tag\.([a-z]{2,3}(?:-[A-Za-z]+)*)\.json$/

/**
 * 有表的语言 —— **从 `server/data/` 实际有哪些文件推出来**，不手抄。
 *
 * 这层过滤是安全边界，不是文档：`lang` 来自查询串，会被拼进 `tag.${lang}.json` 的
 * 路径里。不挡的话 `?lang=../../../../some/path` 就把仓库外任意一个 `.json` 当成
 * 翻译表读进来，而 `searchTagsByTranslation` 还能按子串把它的 key 一个个问出来。
 * 集合来自 `readdir` + 上面那条正则，所以 `lang` 只能精确等于某个真实文件名的中段，
 * 穿越无从谈起。顺带堵住第二个洞：`cache` / `searchIndex` 以 `lang` 为键且无上界，
 * 不挡的话灌一串没见过的值就能把内存撑起来，且每次都触发一次同步 `readFileSync`。
 *
 * 手写一份 `['zh-Hans', 'ja']` 也能达到同样效果，但那是这个目录内容的第三份真相
 * （另两份是文件本身和 `scripts/tags/build_tag_i18n.py`）—— 加一门语言时漏掉它的
 * 表现是新表被静默忽略。派生一次，加语言就只是放一个文件进去。
 *
 * ⚠️ `en` **不在**里面，而且是故意的：原始 tag 名就是英文显示名，没有表要查，
 * 返回 `null` 让调用方回退到原始名正是想要的行为。
 *
 * 挡在这一层而不是 HTTP 边界，是为了**语义**不是因为契约冻结：未知语言的正确行为
 * 是"没有翻译，用原始名"，不是 400。（契约本身挡不住 —— `routes/tags.ts` 的
 * `limit` 就是用 `.refine()` 加的校验，refine 不产出 OpenAPI 约束，同样的手法对
 * `lang` 一样可用。）
 */
const supportedLangs = (() => {
  let cached: Set<string> | undefined
  return (): Set<string> => {
    if (cached)
      return cached
    cached = new Set<string>()
    try {
      for (const name of fs.readdirSync(path.resolve(repoRoot(), DATA_DIR))) {
        const m = TABLE_FILE.exec(name)
        if (m)
          cached.add(m[1]!)
      }
    }
    catch (err) {
      console.warn(`[tag-i18n] 读不到 ${DATA_DIR}，所有 tag 都不翻译：${String(err)}`)
    }
    return cached
  }
})()

const EMPTY: Record<string, string> = Object.freeze({})

const cache = new Map<string, Record<string, string>>()

function table(lang: string): Record<string, string> {
  if (!supportedLangs().has(lang))
    return EMPTY

  const hit = cache.get(lang)
  if (hit)
    return hit

  const file = path.resolve(repoRoot(), DATA_DIR, `tag.${lang}.json`)
  let loaded: Record<string, string> = {}
  try {
    loaded = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
  }
  catch {
    console.warn(`[tag-i18n] 没有 ${lang} 的翻译表: ${file}`)
  }
  cache.set(lang, loaded)
  return loaded
}

/**
 * DB tag 名的本地化显示名，未知时返回 `null`。
 *
 * `en` 走的是"没有表"那条路（见 `supportedLangs`）：原始 tag 名就是英文显示名。
 */
export function translateTag(name: string, lang = 'zh-Hans'): string | null {
  return table(lang)[name] ?? null
}

/**
 * `IN (...)` 参数表的上限，与 Python 侧 `MAX_TRANSLATION_MATCHES` 同值。
 *
 * 只有单个 CJK 字符的查询才会接近它；SQLite 的变量上限是 32766，5000 给调用方的
 * 其它参数留足了余量。
 */
const MAX_TRANSLATION_MATCHES = 5000

/** `(小写显示名, DB tag 名)` 的搜索索引，按 lang 缓存一次（同样只对有表的语言建）。 */
const searchIndex = new Map<string, Array<[string, string]>>()

function index(lang: string): Array<[string, string]> {
  // 这道判断不能省：没有它 `searchIndex` 会给每个没见过的 lang 存一个空数组，
  // 又变回一张无上界的表。
  if (!supportedLangs().has(lang))
    return []
  const hit = searchIndex.get(lang)
  if (hit)
    return hit
  const built = Object.entries(table(lang)).map(([name, display]) =>
    [display.toLowerCase(), name] as [string, string])
  searchIndex.set(lang, built)
  return built
}

/**
 * 本地化显示名包含 `query` 的那些 DB tag 名。
 *
 * 大小写不敏感的子串匹配，线性扫 —— 10 万条表上几毫秒，躲在前端 250ms 的防抖后面
 * 完全够用。空查询返回 `[]`；`en` 也是（没有表，而用户输入的本来就是原始 tag 名）。
 *
 * 注：Python 侧用 `str.casefold()`，JS 只有 `toLowerCase()`。两者只在 'ß'→'ss'
 * 这类欧洲语言的特殊折叠上不同，而这张表里是 CJK 显示名，落不到那个差异上。
 */
export function searchTagsByTranslation(query: string, lang = 'zh-Hans'): string[] {
  const q = query.trim().toLowerCase()
  if (!q)
    return []
  const matches: string[] = []
  for (const [display, name] of index(lang)) {
    if (display.includes(q)) {
      matches.push(name)
      if (matches.length >= MAX_TRANSLATION_MATCHES)
        break
    }
  }
  return matches
}
