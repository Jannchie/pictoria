/**
 * Tag 的语义分类树 —— danbooru-tags-tree 的 taxonomy，`server/data/tag-tree.json`。
 *
 * 和 [tag-i18n.ts] 同一个模式（离线脚本生成表、进程首次使用时读一次），但这里是
 * **一张表配四种语言**而不是一语一表：整棵树只有 888 个短标签，四语加起来 0.5 MB，
 * 分文件反而是四次 I/O 和四份缓存。表由 `server/scripts/tags/build_tag_tree.py`
 * 生成，上游是 https://github.com/Jannchie/danbooru-tags-tree。
 *
 * ⚠️ 这个分类和 `tag_groups` 是**正交**的两个维度，别混：`tag_groups` 装的是
 * danbooru 的 tag *type*（general / character / artist / copyright / meta，决定
 * 着色），一个 tag 必属其一；这里是 *语义* 归属（服饰 / 构图 / 表情…），只有
 * general 类的 tag 才在树里，且只覆盖其中约七成——按 post_count 加权是 99.5%，
 * 漏掉的是长尾。所以「树里没有」是常态，不是数据缺陷。
 */
import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './paths.js'

const TABLE_PATH = 'server/data/tag-tree.json'

/** 表里实际带的语言。`en` 一定有（生成脚本用路径末段兜底）。 */
const FALLBACK_LANG = 'en'

interface RawCategory {
  path: string
  parent: string | null
  depth: number
  names: Record<string, string>
}

interface RawTable {
  meta?: { version?: string | null, categories?: number, tags?: number }
  categories: RawCategory[]
  /** category path -> 该分类直属的 tag 名（只有叶子有）。 */
  tags: Record<string, string[]>
}

const EMPTY: RawTable = Object.freeze({ categories: [], tags: {} }) as RawTable

let cached: RawTable | undefined

function table(): RawTable {
  if (cached)
    return cached
  const file = path.resolve(repoRoot(), TABLE_PATH)
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8')) as RawTable
  }
  catch (err) {
    // 缺表不是致命的：分类只是展示层的组织方式，没有它前端回落到不分组。
    console.warn(`[tag-tree] 读不到 ${TABLE_PATH}，标签分类不可用：${String(err)}`)
    cached = EMPTY
  }
  return cached
}

export interface TagCategory {
  path: string
  parent: string | null
  depth: number
  name: string
  /** 直属于这个分类的 tag 名（非叶子为空数组）。 */
  tags: string[]
}

/**
 * 整棵树，按 `lang` 取名，顺序即上游文件的深度优先序。
 *
 * 保留这个顺序是有意的：前端要按它自上而下渲染可折叠分组，重新排序会打乱上游
 * 精心安排的兄弟节点次序（比如 character 下 demographic 先于 depiction）。
 */
export function tagTree(lang = 'zh-Hans'): TagCategory[] {
  const raw = table()
  return raw.categories.map(c => ({
    path: c.path,
    parent: c.parent,
    depth: c.depth,
    name: c.names[lang] ?? c.names[FALLBACK_LANG] ?? c.path,
    tags: raw.tags[c.path] ?? [],
  }))
}
