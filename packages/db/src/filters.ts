/**
 * `PostFilter` → SQL 片段 —— 形状承自已退役的 Python 侧 `db/filters.py`。
 *
 * 这是"一次读取碰哪些 post"的唯一真理，列举、搜索、计数、聚合都消费它。字段名
 * 保持 snake_case：它直接就是 API 的请求体形状（见 §4.2，这一族模型对外就是
 * snake_case），改成 camelCase 会让 HTTP 层多一次无谓的换名。
 */
import { placeholders } from './sql.js'
import {
  FILTERABLE_SCORERS,
  levelsField,
  orderColumn,
  SCORE_BUCKET_UNSCORED,
  WAIFU,
  type Buckets,
  type FilterableScorerName,
} from './scorers.js'

/**
 * 每个可筛打分器的分档字段。字段名由注册表里的名字派生，所以加一个打分器不需要
 * 在这里多写一行 —— 而漏写一行的后果是它的过滤在类型上就不存在。
 */
type ScorerLevelFacets = {
  [K in FilterableScorerName as `${K}_score_levels`]?: string[] | null
}

export interface PostFilter extends ScorerLevelFacets {
  rating?: number[] | null
  score?: number[] | null
  tags?: string[] | null
  extension?: string[] | null
  folder?: string | null
  /** [L, a, b] */
  lab?: [number, number, number] | null
  /** [min, max]，闭区间 */
  waifu_score_range?: [number, number] | null
  /**
   * 默认 true：隐藏近重复分组的**成员**，只返回 canonical 代表
   * （canonical_post_id IS NULL）。设 false 才包含成员。
   */
  only_canonical?: boolean
}

/**
 * 插入序就是 API 那个 `order_by` 枚举的取值序，别重排 —— 它出现在 OpenAPI 契约里。
 * 打分器那几列由注册表派生，`discrepancy` 是真正的特例（它是两个分数的差，不属于
 * 任何一个打分器）。
 */
export const ORDERABLE_COLUMNS = new Set<string>([
  'id',
  'score',
  'rating',
  'created_at',
  'published_at',
  'file_name',
  'last_accessed_at',
  'updated_at',
  ...FILTERABLE_SCORERS.map(orderColumn),
  'discrepancy',
])

export const UPDATABLE_FIELDS = new Set([
  'score',
  'rating',
  'caption',
  'source',
  'description',
  'meta',
])

export const BULK_UPDATABLE_FIELDS = new Set(['score', 'rating'])

export const GROUPABLE_COLUMNS = new Set(['rating', 'score', 'extension'])

export interface WhereParts {
  where: string[]
  params: unknown[]
  joins: string[]
}

function bucketLevelFilter(
  levels: readonly string[],
  buckets: Buckets,
  scoreCol: string,
  nullCol: string,
): { clause: string, params: number[] } {
  const clauses: string[] = []
  const params: number[] = []
  let includeUnscored = false

  for (const lvl of levels) {
    if (lvl === SCORE_BUCKET_UNSCORED) {
      includeUnscored = true
      continue
    }
    const edges = buckets[lvl]
    if (!edges)
      continue
    clauses.push(`(${scoreCol} >= ? AND ${scoreCol} < ?)`)
    params.push(edges[0], edges[1])
  }
  if (includeUnscored)
    clauses.push(`${nullCol} IS NULL`)

  return { clause: clauses.length ? `(${clauses.join(' OR ')})` : '', params }
}

/**
 * 是否设了任何**内容**过滤 —— 刻意不看 `only_canonical`。
 *
 * tag facet 的快路径在没有内容过滤时读denormalised 的 `tags.post_count`
 * （它本身已经是"只数 canonical"的计数），所以单独一个 only_canonical 不该
 * 让它失去快路径资格。
 */
export function hasActiveFilters(f: PostFilter): boolean {
  return Boolean(
    f.rating?.length
    || f.score?.length
    || f.tags?.length
    || f.extension?.length
    || (f.folder && f.folder !== '.')
    || f.lab
    || f.waifu_score_range
    || FILTERABLE_SCORERS.some(spec => f[levelsField(spec)]?.length),
  )
}

/**
 * 把 `PostFilter` 翻成 `(where, params, joins)`。
 *
 * `lab` 故意不在这里处理：距离排序需要 SELECT 列表里的表达式和特殊 ORDER BY，
 * 归搜索方法自己管。
 */
export function buildWhere(f: PostFilter): WhereParts {
  const where: string[] = []
  const params: unknown[] = []
  const joins: string[] = []

  // 默认 true —— 与 Python 侧 msgspec 的字段默认值一致。
  if (f.only_canonical ?? true)
    where.push('p.canonical_post_id IS NULL')

  if (f.rating?.length) {
    where.push(`p.rating IN (${placeholders(f.rating.length)})`)
    params.push(...f.rating)
  }
  if (f.score?.length) {
    where.push(`p.score IN (${placeholders(f.score.length)})`)
    params.push(...f.score)
  }
  if (f.tags?.length) {
    // AND 语义：post 必须带上**每一个**选中的 tag。每个 tag 一条相关 EXISTS
    // （单个 IN(...) 会变成 OR），每条都命中 post_has_tag 的主键 (post_id, tag_name)，
    // 所以仍然走索引。
    for (const tag of f.tags) {
      where.push(
        'EXISTS (SELECT 1 FROM post_has_tag pht WHERE pht.post_id = p.id AND pht.tag_name = ?)',
      )
      params.push(tag)
    }
  }
  if (f.extension?.length) {
    where.push(`p.extension IN (${placeholders(f.extension.length)})`)
    params.push(...f.extension)
  }
  if (f.folder && f.folder !== '.') {
    // 精确前缀语义：文件夹本身，或它下面的任何东西（'0' 是 '/' 之后的那个码位）。
    // 早先的 `GLOB folder*` 会连带匹配同前缀的兄弟目录（`art` 命中 `art2`），
    // 而且文件夹名里出现 `[ ] * ?` 时会彻底失效。
    where.push('(p.file_path = ? OR (p.file_path >= ? AND p.file_path < ?))')
    params.push(f.folder, `${f.folder}/`, `${f.folder}0`)
  }

  // waifu 的 join 先于分档循环，因为分数区间（只有 waifu 有）也要用它。
  if (f.waifu_score_range || f[levelsField(WAIFU)]?.length)
    joins.push(WAIFU.joinSql())

  if (f.waifu_score_range) {
    where.push(`${WAIFU.scoreCol()} >= ? AND ${WAIFU.scoreCol()} <= ?`)
    params.push(f.waifu_score_range[0], f.waifu_score_range[1])
  }

  // 每个打分器贡献自己的 LEFT JOIN + 分档子句。waifu 也走这条路 —— 它的表、别名
  // 和“不带 scorer 谓词”这三点差异全都封在 spec 里，这里看不出来，于是加一个打分
  // 器不再是给这段再抄一份。
  //
  // ⚠️ 循环顺序 = `FILTERABLE_SCORERS` 的顺序 = 原来手写的顺序（waifu → silva →
  // silva_luna）。`filters.test.ts` 对拍的是冻结的 SQL 文本，子句换个位置就不等了。
  for (const spec of FILTERABLE_SCORERS) {
    const levels = f[levelsField(spec)]
    if (!levels?.length)
      continue
    if (!spec.isJoined(joins))
      joins.push(spec.joinSql())
    const { clause, params: bp } = bucketLevelFilter(
      levels,
      spec.buckets,
      spec.scoreCol(),
      spec.nullCol(),
    )
    if (clause) {
      where.push(clause)
      params.push(...bp)
    }
  }

  return { where, params, joins }
}
