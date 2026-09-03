/**
 * 质量分档 A–E 的唯一词汇表。
 *
 * 后端只认字母：`packages/db/src/scorers.ts` 的分档边界就是按 `A`…`E` 存的，
 * `filters.ts` 的 `bucketLevelFilter` 直接拿收到的字符串去查那张表。而命令面板的
 * 过滤 DSL 一直用 `best`/`good`/… 这套别名，两套词汇之间没有任何翻译层，于是
 * **两个方向都是断的**：
 *
 * - 输入 `silva:good` → 写进 `silva_score_levels: ['good']` → 后端查
 *   `buckets['good']` 得到 undefined 就 `continue`，子句为空，**筛选被静默丢掉**，
 *   而界面上看起来是生效了的；
 * - 在 popover 里选了 A、B 之后，`stringifyFilterQuery` 输出 `silva:A`，而解析器
 *   不认这个字母，于是命令面板**无法 round-trip 自己刚刚的输出**；
 * - `useActiveFilters` 的 `bucketLabel('A')` 查不到 key，chip 只好回退显示裸字母，
 *   于是 chip 上写着 "SILVA A" 而 popover 里同一行写着"最佳"。
 *
 * 这张表把两套写法钉在同一行上。**level 是唯一会离开前端的形态**：解析两种写法
 * 都接受，但一律归一成 level 再写进 `postFilter`。
 */

export interface BucketDef {
  /** 后端认的形态，也是存进 `postFilter` 的形态。 */
  level: string
  /** DSL 里友好的写法，也是 `stringifyFilterQuery` 输出的形态。 */
  alias: string
  labelKey: string
}

/** popover 的行序（上 → 下），也是 DSL 的合法取值全集。 */
export const BUCKETS: readonly BucketDef[] = [
  { level: 'A', alias: 'best', labelKey: 'filter.bucketBest' },
  { level: 'B', alias: 'good', labelKey: 'filter.bucketGood' },
  { level: 'C', alias: 'normal', labelKey: 'filter.bucketNormal' },
  { level: 'D', alias: 'bad', labelKey: 'filter.bucketBad' },
  { level: 'E', alias: 'worst', labelKey: 'filter.bucketWorst' },
  // 没有分数的那一档。它同样能在 popover 里被选中，所以也必须能被 DSL 表达，
  // 否则选中它之后命令面板照样 round-trip 不回来。
  { level: 'UNSCORED', alias: 'unscored', labelKey: 'common.unscored' },
]

const BY_TOKEN = new Map<string, BucketDef>()
for (const b of BUCKETS) {
  BY_TOKEN.set(b.level.toLowerCase(), b)
  BY_TOKEN.set(b.alias, b)
}

/**
 * DSL 里的一个分档词 → 后端认的 level，不认识则 `null`。
 *
 * 字母和别名都接受，大小写不敏感 —— 用户看到 chip 上写着 `A` 就会去命令面板里
 * 敲 `silva:A`，那应该能用。
 */
export function toBucketLevel(token: string): string | null {
  return BY_TOKEN.get(token.toLowerCase())?.level ?? null
}

/** level → DSL 输出用的别名。认不出来时原样返回，宁可输出得糙也不要丢信息。 */
export function toBucketAlias(level: string): string {
  return BY_TOKEN.get(level.toLowerCase())?.alias ?? level
}

/**
 * 一个分档词的 i18n key，字母和别名都认。
 *
 * 两种都认不是冗余：`postFilter` 是持久化的，历史上存进去的别名（那些本来就被
 * 后端丢掉的）还在用户的 localStorage 里，chip 不该因为这次归一而退化成裸字符串。
 */
export function bucketLabelKey(token: string): string | undefined {
  return BY_TOKEN.get(token.toLowerCase())?.labelKey
}

/**
 * popover 的行 = 共享的分档定义 + 这个打分器自己的数值区间文案。
 *
 * 只有区间是各家不同的（waifu 是 0–10，两个 SILVA 是 0–1），level / labelKey /
 * 行序都来自上面那张表。按 level 取而不是按下标取：加一档时下标会整体错位，而
 * 错位是静默的。
 */
export function bucketRows(ranges: Record<string, string>): Array<BucketDef & { range: string }> {
  return BUCKETS.map(b => ({ ...b, range: ranges[b.level] ?? '' }))
}
