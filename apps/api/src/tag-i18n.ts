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
import { repoRoot } from './db.js'

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
