/**
 * Tag 显示名的本地化 —— 对应 Python 侧 `services/tag_i18n.py`。
 *
 * `server/data/tag.<lang>.json` 把 DB 里的 tag 名（danbooru 下划线形式，
 * `green_eyes`）映射到本地化显示名。表由 `scripts/tags/build_tag_i18n.py` 离线生成。
 * 英文不需要表（tag 本身就是英文显示名），所以缺表或缺条目都返回 `null`，调用方
 * 回退到原始名。表按进程首次使用时加载一次（zh-Hans 约 2 MB JSON）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './paths.js'

const cache = new Map<string, Record<string, string>>()

function table(lang: string): Record<string, string> {
  const hit = cache.get(lang)
  if (hit)
    return hit

  const file = path.resolve(repoRoot(), 'server/data', `tag.${lang}.json`)
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
 * `en` 直接短路：原始 tag 名**就是**英文显示名，没有表要查（也就不该发出缺表警告）。
 */
export function translateTag(name: string, lang = 'zh-Hans'): string | null {
  if (lang === 'en')
    return null
  return table(lang)[name] ?? null
}

/**
 * `IN (...)` 参数表的上限，与 Python 侧 `MAX_TRANSLATION_MATCHES` 同值。
 *
 * 只有单个 CJK 字符的查询才会接近它；SQLite 的变量上限是 32766，5000 给调用方的
 * 其它参数留足了余量。
 */
const MAX_TRANSLATION_MATCHES = 5000

/** `(小写显示名, DB tag 名)` 的搜索索引，按 lang 缓存一次。 */
const searchIndex = new Map<string, Array<[string, string]>>()

function index(lang: string): Array<[string, string]> {
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
 * 完全够用。空查询和 `en` 返回 `[]`（没有表，而用户输入的本来就是原始 tag 名）。
 *
 * 注：Python 侧用 `str.casefold()`，JS 只有 `toLowerCase()`。两者只在 'ß'→'ss'
 * 这类欧洲语言的特殊折叠上不同，而这张表里是 CJK 显示名，落不到那个差异上。
 */
export function searchTagsByTranslation(query: string, lang = 'zh-Hans'): string[] {
  const q = query.trim().toLowerCase()
  if (!q || lang === 'en')
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
