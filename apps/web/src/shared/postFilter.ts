import type { ScorerUi } from './scorers'
/**
 * 画廊筛选条件（PostFilter）的唯一描述。
 *
 * 同一个概念过去有五份手写的编解码：URL 同步（state.ts）、过滤 DSL
 * （utils/filterDsl.ts）、chip 列表（useActiveFilters）、请求体（queries.ts）、
 * 命令面板写回（CommandPalette.vue）。每加一个字段要改五处，漏一处就静默丢失 ——
 * 命令面板把三个打分器字段写死，加第四个打分器时它就会被"应用"丢掉。
 *
 * 现在每个数组型筛选字段（facet）在 {@link FILTER_FACETS} 里**只描述一次**：
 * URL 怎么编码、DSL 认哪些键怎么解析/输出、chip 长什么样。上面五处全部遍历这张
 * 表；打分器字段由 `SCORERS` 生成，加打分器不用碰这个文件。
 *
 * 纯 TS：不碰 Vue 响应式、路由或 i18n 实例（`t` 由调用方传入），所以可以直接单测。
 */
import type { PostFilterWithOrder } from '@/api'
import { expandRange, RATING_ALIASES, splitOp, tokenize } from '@/utils/filterDsl'
import { naturalizeTagName } from '@/utils/tagName'
import { bucketLabelKey, toBucketAlias, toBucketLevel } from './buckets'
import { MAX_POST_RATING, MAX_POST_SCORE, RATING_ICON, ratingName, SCORE_ICON } from './ratings'
import { SCORERS } from './scorers'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 后端认的排序列 —— 从生成的 API 类型推导，不手抄。 */
export type PostOrderColumn = NonNullable<PostFilterWithOrder['orderBy']>
/**
 * 用户能选的排序列。`last_accessed_at` 只由 /recently 页强制使用，不是一个
 * 可持久化的用户选择。
 */
export type PostSortColumn = Exclude<PostOrderColumn, 'last_accessed_at'>
export type PostSortOrder = 'asc' | 'desc'

/** 数组型筛选字段。分档字段由打分器表的 `levelsField` 联合派生。 */
export interface PostFilterFacets extends Record<ScorerUi['levelsField'], string[]> {
  rating: number[]
  score: number[]
  tags: string[]
  extension: string[]
}
export type FacetField = keyof PostFilterFacets
export type FacetValue = PostFilterFacets[FacetField][number]

/** 画廊的完整筛选状态（`postFilter` ref 的形状）。 */
export interface PostFilterState extends PostFilterFacets {
  /** 由路由（useWatchRoute）驱动，不进 URL query、不被"清除全部"清掉。 */
  folder?: string
  waifuScoreRange?: [number, number]
}

/** DSL 解析结果。 */
export interface ParsedFilter extends PostFilterFacets {
  /** Leftover free text — the semantic-search prompt. */
  text: string
  /** Terms that looked like `key:value` but weren't understood. */
  unknown: string[]
}

/** 与 `useI18n().t` / `i18n.global.t` 兼容的最小签名。 */
export type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string

// ---------------------------------------------------------------------------
// The field table
// ---------------------------------------------------------------------------

interface FacetSpec<V extends FacetValue> {
  readonly field: FacetField
  /** URL：参数名就是字段名。`numeric` 解码成数字；`encode` 逐项百分号编码（值里可能有逗号）。 */
  readonly url: { readonly numeric?: boolean, readonly encode?: boolean }
  /**
   * DSL 里认的键（小写）。第一个是规范写法，也是 chip id 的前缀（`<key>:<value>`）；
   * `stringifyFilterQuery` 用的不是它而是 `formatDsl`。
   */
  readonly dslKeys: readonly string[]
  /** 解析 `key:<op><value>`；`null` = 不认识（记进 `unknown`）。 */
  readonly parseDsl: (op: string, value: string) => V[] | null
  /** 一个值 → 一个 DSL 词。 */
  readonly formatDsl: (value: V) => string
  /** 解析后与输出前按数值升序排（离散标度：rating / score）。 */
  readonly sorted?: boolean
  readonly chipIcon: string
  readonly chipLabel: (value: V, t: Translate) => string
}

/** 把带具体值类型的 spec 收进统一的表里（值类型在表内只在运行时区分）。 */
function facet<V extends FacetValue>(spec: FacetSpec<V>): FacetSpec<FacetValue> {
  return spec as unknown as FacetSpec<FacetValue>
}

/** rating 0..4 在 DSL 输出里的名字。 */
const RATING_DSL_NAMES = ['unrated', 'general', 'sensitive', 'questionable', 'explicit']

function bucketLabel(level: string, t: Translate): string {
  const key = bucketLabelKey(level)
  return key ? t(key) : level
}

/**
 * 每个数组型筛选字段一行。**表的顺序就是 DSL 输出与 chip 的顺序。**
 *
 * 加一个字段：在 `PostFilterFacets` 里声明，在这里加一行；URL 同步、DSL、chip、
 * 请求体、命令面板写回、"清除全部"全部自动跟上。
 */
export const FILTER_FACETS: readonly FacetSpec<FacetValue>[] = [
  facet<number>({
    field: 'rating',
    url: { numeric: true },
    dslKeys: ['rating', 'r'],
    parseDsl: (op, value) => {
      const n = RATING_ALIASES[value.toLowerCase()] ?? Number(value)
      return Number.isFinite(n) ? expandRange(op, n, MAX_POST_RATING) : null
    },
    formatDsl: r => `rating:${RATING_DSL_NAMES[r] ?? r}`,
    sorted: true,
    chipIcon: RATING_ICON,
    chipLabel: (r, t) => ratingName(r, t),
  }),
  facet<number>({
    field: 'score',
    url: { numeric: true },
    dslKeys: ['score', 'sc'],
    parseDsl: (op, value) => {
      const n = Number(value)
      return Number.isFinite(n) ? expandRange(op, n, MAX_POST_SCORE) : null
    },
    formatDsl: s => `score:${s}`,
    sorted: true,
    chipIcon: SCORE_ICON,
    chipLabel: (s, t) => t('filter.star', { n: s }, s),
  }),
  facet<string>({
    field: 'tags',
    url: { encode: true },
    dslKeys: ['tag', 't'],
    // Tags are stored with underscores; accept spaces as the friendly form.
    parseDsl: (_op, value) => [value.replaceAll(' ', '_')],
    formatDsl: tag => (tag.includes(' ') ? `tag:"${tag}"` : `tag:${tag}`),
    chipIcon: 'i-tabler-tag',
    chipLabel: tag => naturalizeTagName(tag),
  }),
  facet<string>({
    field: 'extension',
    url: {},
    dslKeys: ['ext', 'extension'],
    parseDsl: (_op, value) => [value.toLowerCase().replace(/^\./, '')],
    formatDsl: ext => `ext:${ext}`,
    chipIcon: 'i-tabler-file',
    chipLabel: (ext, t) => ext || t('filter.noExtension'),
  }),
  // 打分器分档：字母和别名都接受，但一律归一成后端认的 level；输出别名（可 round-trip）。
  ...SCORERS.map(spec => facet<string>({
    field: spec.levelsField,
    url: {},
    dslKeys: [spec.dslKey],
    parseDsl: (_op, value) => {
      const level = toBucketLevel(value)
      return level ? [level] : null
    },
    formatDsl: lvl => `${spec.dslKey}:${toBucketAlias(lvl)}`,
    chipIcon: spec.icon,
    chipLabel: (lvl, t) => `${spec.chipPrefix} ${bucketLabel(lvl, t)}`,
  })),
]

const BY_DSL_KEY = new Map<string, FacetSpec<FacetValue>>()
for (const spec of FILTER_FACETS) {
  for (const key of spec.dslKeys) {
    if (BY_DSL_KEY.has(key)) {
      throw new Error(`postFilter: DSL key "${key}" is claimed by two fields`)
    }
    BY_DSL_KEY.set(key, spec)
  }
}

/** DSL 认识的全部键（含别名），例如命令面板拿来判断一个 chip 是否"未知"。 */
export const FILTER_DSL_KEYS: ReadonlySet<string> = new Set(BY_DSL_KEY.keys())

/** 一个（小写的）DSL 键属于哪个筛选字段；不认识的键 → `undefined`。 */
export function facetForDslKey(key: string): FacetField | undefined {
  return BY_DSL_KEY.get(key)?.field
}

function values(filter: PostFilterFacets, field: FacetField): FacetValue[] {
  return filter[field] as FacetValue[]
}

// ---------------------------------------------------------------------------
// Empty / clear / apply
// ---------------------------------------------------------------------------

export function emptyFacets(): PostFilterFacets {
  return Object.fromEntries(FILTER_FACETS.map(f => [f.field, []])) as unknown as PostFilterFacets
}

/** 只取 facet 字段（新数组，不共享引用）。 */
export function pickFacets(source: PostFilterFacets): PostFilterFacets {
  return Object.fromEntries(FILTER_FACETS.map(f => [f.field, [...values(source, f.field)]])) as unknown as PostFilterFacets
}

/** "清除全部"：清空每个 facet 和 waifu 区间；`folder` 由路由决定，保留。 */
export function clearFilter(current: PostFilterState): PostFilterState {
  return { ...current, ...emptyFacets(), waifuScoreRange: undefined }
}

/** 去掉某个 facet 里的一个值，其余不动。 */
export function withoutFacetValue(current: PostFilterState, field: FacetField, value: FacetValue): PostFilterState {
  return { ...current, [field]: values(current, field).filter(v => v !== value) }
}

/**
 * 命令面板"应用"：输入框就是全部 facet 的状态（打开时用当前筛选播种），所以
 * 每个 facet 都要写回 —— 包括被删掉词的那些（删 chip 再应用必须真的去掉）。
 */
export function applyParsedFilter(current: PostFilterState, parsed: ParsedFilter): PostFilterState {
  return { ...current, ...pickFacets(parsed) }
}

// ---------------------------------------------------------------------------
// DSL
// ---------------------------------------------------------------------------

function addUnique<T>(target: T[], items: T[]): void {
  for (const v of items) {
    if (!target.includes(v)) {
      target.push(v)
    }
  }
}

/** 解析过滤 DSL（语法见 `utils/filterDsl.ts` 文件头）。 */
export function parseFilterQuery(input: string): ParsedFilter {
  const result: ParsedFilter = { ...emptyFacets(), text: '', unknown: [] }
  const freeText: string[] = []

  for (const token of tokenize(input)) {
    const idx = token.indexOf(':')
    // No colon, or a colon at the very start/end — treat as free text.
    if (idx <= 0 || idx === token.length - 1) {
      freeText.push(token)
      continue
    }
    const spec = BY_DSL_KEY.get(token.slice(0, idx).toLowerCase())
    if (!spec) {
      result.unknown.push(token)
      // An unrecognised key is still words the user typed — keep it
      // searchable rather than swallowing it.
      freeText.push(token)
      continue
    }
    const [op, value] = splitOp(token.slice(idx + 1))
    const parsed = spec.parseDsl(op, value)
    if (parsed) {
      addUnique(values(result, spec.field), parsed)
    }
    else {
      result.unknown.push(token)
    }
  }

  result.text = freeText.join(' ').trim()
  for (const spec of FILTER_FACETS) {
    if (spec.sorted) {
      (values(result, spec.field) as number[]).sort((a, b) => a - b)
    }
  }
  return result
}

/** Inverse of the parser: renders live filter state back into the syntax. */
export function stringifyFilterQuery(filter: PostFilterFacets, text = ''): string {
  const parts: string[] = []
  for (const spec of FILTER_FACETS) {
    const list = spec.sorted
      ? [...values(filter, spec.field) as number[]].sort((a, b) => a - b)
      : values(filter, spec.field)
    for (const v of list) {
      parts.push(spec.formatDsl(v))
    }
  }
  const trimmed = text.trim()
  if (trimmed) {
    parts.push(trimmed)
  }
  return parts.join(' ')
}

/** True when the input contains at least one recognised `key:value` term. */
export function hasFilterTerms(parsed: PostFilterFacets): boolean {
  return FILTER_FACETS.some(spec => values(parsed, spec.field).length > 0)
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** 进 URL 的那部分画廊状态。 */
export interface FilterUrlState {
  filter: PostFilterState
  sort: PostSortColumn
  order: PostSortOrder
  sortColor: string | undefined
}

/** vue-router 的 query 值形状（`LocationQuery` 的值）。 */
type QueryValue = string | null | (string | null)[] | undefined
type QueryLike = Record<string, QueryValue>

/** `fromQuery` 的结果：只含 URL 里**出现了**的键（缺席的键不覆盖现有状态）。 */
export interface FilterQueryPatch {
  filter: Partial<Pick<PostFilterState, FacetField | 'waifuScoreRange'>>
  sort?: PostSortColumn
  order?: PostSortOrder
  sortColor?: string
}

// vue-router query values are `string | null | (string | null)[]`: a valueless
// param (`?score`) yields null and a repeated key (`?tags=a&tags=b`) an array.
// Our own URLs only ever produce single comma-joined strings, but hand-edited
// or shared URLs can produce the other shapes — calling .split on them threw
// inside the immediate route watcher and broke filter sync for the session.
// Normalize to the first string value, or undefined when there is none.
function queryParamString(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw : undefined
}

function encodeFacet(spec: FacetSpec<FacetValue>, list: readonly FacetValue[]): string {
  return spec.url.encode ? list.map(v => encodeURIComponent(String(v))).join(',') : list.join(',')
}

/** URL query → 状态补丁。 */
export function filterFromQuery(query: QueryLike): FilterQueryPatch {
  const patch: FilterQueryPatch = { filter: {} }
  for (const spec of FILTER_FACETS) {
    const raw = queryParamString(query[spec.field])
    if (raw !== undefined) {
      const parts = raw.split(',')
      const decoded = spec.url.encode ? parts.map(p => decodeURIComponent(p)) : parts
      ;(patch.filter as Record<string, unknown>)[spec.field] = spec.url.numeric ? decoded.map(Number) : decoded
    }
  }
  const range = queryParamString(query.waifuScoreRange)
  if (range !== undefined) {
    patch.filter.waifuScoreRange = range.split(',').map(Number) as [number, number]
  }
  const sort = queryParamString(query.sort)
  if (sort !== undefined) {
    patch.sort = sort as PostSortColumn
  }
  const order = queryParamString(query.order)
  if (order !== undefined) {
    patch.order = order as PostSortOrder
  }
  const sortColor = queryParamString(query.sort_color)
  if (sortColor !== undefined) {
    patch.sortColor = sortColor
  }
  return patch
}

/**
 * 状态 → URL query：在 `base`（当前 query）上设置/删除筛选与排序参数，其他参数
 * 原样保留。排序的默认值（sort=id、order=desc）省略，URL 保持干净。
 */
export function filterToQuery<Q extends Record<string, unknown>>(state: FilterUrlState, base: Q): Q {
  const query: Record<string, unknown> = { ...base }
  for (const spec of FILTER_FACETS) {
    const list = values(state.filter, spec.field)
    if (list.length > 0) {
      query[spec.field] = encodeFacet(spec, list)
    }
    else {
      delete query[spec.field]
    }
  }
  if (state.filter.waifuScoreRange) {
    query.waifuScoreRange = state.filter.waifuScoreRange.join(',')
  }
  else {
    delete query.waifuScoreRange
  }
  if (state.sort === 'id') {
    delete query.sort
  }
  else {
    query.sort = state.sort
  }
  if (state.order === 'desc') {
    delete query.order
  }
  else {
    query.order = state.order
  }
  if (state.sortColor) {
    query.sort_color = state.sortColor
  }
  else {
    delete query.sort_color
  }
  return query as Q
}

/**
 * 可比较的原始值签名，供 filter → URL 的 watcher 用。按 URL 的编码方式编码，
 * 所以含 `,` 的值不会让两个不同的选择撞成同一个签名（从而跳过一次同步）。
 */
export function filterQuerySignature(state: FilterUrlState): string[] {
  return [
    ...FILTER_FACETS.map(spec => encodeFacet(spec, values(state.filter, spec.field))),
    state.filter.waifuScoreRange?.join(',') ?? '',
    state.sort,
    state.order,
    state.sortColor ?? '',
  ]
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

/** 筛选状态 → `PostFilter` 请求体字段。 */
export function filterToBody(filter: PostFilterState): PostFilterState {
  return {
    ...pickFacets(filter),
    ...('folder' in filter ? { folder: filter.folder } : {}),
    ...('waifuScoreRange' in filter ? { waifuScoreRange: filter.waifuScoreRange } : {}),
  }
}

/** 画廊列表请求所在的页面种类 —— 决定排序语义。 */
export type GalleryListMode = 'default' | 'random' | 'recently'

/**
 * `/v2/posts/search` 的请求体（不含分页参数）。
 *
 * - /recently：强制按 `last_accessed_at` 降序。
 * - /random：`order=random` + 固定种子（offset 分页需要稳定的洗牌）。默认排序
 *   （id —— 排序器的"不指定"）**不能**作为 orderBy 发出去：后端会按收到的任何
 *   orderBy 重排洗过的页，发默认值会把每页随机结果重新排回 id 顺序，纯随机浏览
 *   就到不了了。只有显式选了排序才转发，并带上 `sortDirection`。
 */
export function searchPostsBody(opts: {
  filter: PostFilterState
  mode: GalleryListMode
  sort: PostSortColumn
  sortOrder: PostSortOrder
  seed: number
  lab?: [number, number, number]
}) {
  const { filter, mode, sort, sortOrder, seed, lab } = opts
  const order: PostSortOrder | 'random' = mode === 'random' ? 'random' : mode === 'recently' ? 'desc' : sortOrder
  const orderBy: PostOrderColumn = mode === 'recently' ? 'last_accessed_at' : sort
  const base = {
    ...filterToBody(filter),
    order,
    ...(mode === 'random' && sort === 'id' ? {} : { orderBy }),
    ...(mode === 'random'
      ? { orderSeed: seed, ...(sort === 'id' ? {} : { sortDirection: sortOrder }) }
      : {}),
  }
  return lab ? { ...base, lab } : base
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

/** chip 被移除时要清掉的东西。 */
export type FilterChipTarget
  = | { kind: 'text' }
    | { kind: 'facet', field: FacetField, value: FacetValue }
    | { kind: 'waifuScoreRange' }
    | { kind: 'sortColor' }

export interface FilterChipDescriptor {
  /** Stable identity for :key. */
  id: string
  icon: string
  label: string
  target: FilterChipTarget
}

/**
 * 当前生效的一切收窄条件，拍平成可渲染的 chip 列表（纯数据；移除动作由
 * `useActiveFilters` 按 `target` 绑定）。顺序：语义搜索、各 facet（表序）、
 * waifu 区间、颜色排序。
 */
export function filterChips(
  input: { filter: PostFilterState, text: string, sortColor: string | undefined },
  t: Translate,
): FilterChipDescriptor[] {
  const out: FilterChipDescriptor[] = []
  const text = input.text.trim()
  if (text) {
    out.push({ id: 'text', icon: 'i-tabler-search', label: text, target: { kind: 'text' } })
  }
  for (const spec of FILTER_FACETS) {
    for (const v of values(input.filter, spec.field)) {
      out.push({
        id: `${spec.dslKeys[0]}:${v}`,
        icon: spec.chipIcon,
        label: spec.chipLabel(v, t),
        target: { kind: 'facet', field: spec.field, value: v },
      })
    }
  }
  if (input.filter.waifuScoreRange) {
    const [lo, hi] = input.filter.waifuScoreRange
    out.push({ id: 'waifu-range', icon: 'i-tabler-heart', label: `${lo}–${hi}`, target: { kind: 'waifuScoreRange' } })
  }
  if (input.sortColor) {
    out.push({ id: 'sort-color', icon: 'i-tabler-palette', label: input.sortColor.toUpperCase(), target: { kind: 'sortColor' } })
  }
  return out
}
