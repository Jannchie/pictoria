/**
 * 画面形态注册表 —— 一张图是插画、漫画、设定图还是速涂。
 *
 * 存在的理由是标注体验和信息量在这件事上是同一个答案。跨形态的比较对标注者最难开口
 * （"立绘和漫画哪个更好"没有稳定答案），而实测它也几乎不携带方向信息：2026-09-04 的
 * 5299 条 `overall` 判决里，跨形态对占 16%，illust vs comic 的胜率是 0.49、平局 0.24
 * ——silva 窗口已经按模型分配平了质量，剩下的就是掷硬币。形态之间的相对位置本来也不
 * 需要比较来买：人工绝对分早已编码了它（comic 均值 2.71 vs illust 3.24）。真正判不准
 * 又只有比较能买到的，是同形态、同一档里差一点的那些对（与绝对分一致率 0.664）。
 *
 * 所以 listwise 组按形态收口（见 sampling.ts 的 sampleGroups），形态之间交给绝对分锚。
 *
 * ⚠️ 这是一条**研究中的分类规则**，不是 schema。它没有落成 `posts` 的列，也没有触发器：
 * 规则还会调，而物化的代价是每改一次就要一次迁移加一次全库回填，还要在 1209 万行的
 * `post_has_tag` 上多挂一个 INSERT 触发器。改这里 = 下一批组立刻生效。
 *
 * 标签来源也混杂，这同样是先留在 TS 侧的理由：`translated` / `doujinshi` 只有手工行
 * （Danbooru 元标签），而 `monochrome` / `greyscale` 有一两千行是自动 tagger 打的。
 */

export type Format = 'comic' | 'sheet' | 'sketch' | 'illust'

/**
 * 非 illust 形态各自的标签集合，**数组序即优先级**：一张同时挂着 `comic` 和 `monochrome`
 * 的图归 comic。illust 是余集，没有自己的标签 —— 它是"以上都不是"，不是一个正面定义。
 *
 * 优先级这么排是因为它们回答的问题粒度不同：漫画分格是最强的形态信号（不管它是不是黑白），
 * 设定图次之（多视图/参考表），而 sketch 那一组里 `monochrome` / `greyscale` 只是"没上色"，
 * 最弱，所以垫底。
 */
export const FORMAT_TAGS: ReadonlyArray<readonly [Exclude<Format, 'illust'>, readonly string[]]> = [
  ['comic', ['comic', '4koma', 'speech_bubble', 'translated', 'doujinshi']],
  ['sheet', ['character_sheet', 'reference_sheet', 'multiple_views']],
  ['sketch', ['sketch', 'lineart', 'traditional_media', 'monochrome', 'greyscale']],
]

/**
 * 按优先级判定形态。
 *
 * 传谓词而不是标签集合，是因为调用方手里的形状不一样：采样器持有的是每个形态一个
 * `Set<post_id>`（按标签反查，走 `ix_post_has_tag_tag_name`），而测试和临时脚本手里
 * 往往是一张图的标签数组。两边都能一行接上，而优先级只在这里写一次。
 */
export function resolveFormat(has: (tag: string) => boolean): Format {
  for (const [format, tags] of FORMAT_TAGS)
    if (tags.some(has))
      return format
  return 'illust'
}

/**
 * 同一条优先级，但输入是**每个形态一个 id 集合** —— 采样器手里的形状。
 *
 * 采样器不按图拉标签（那是 1209 万行上的逐行 EXISTS，实测把一次窗口查询从 123 ms 推到
 * 453 ms），而是每个形态一条 `SELECT DISTINCT post_id ... WHERE tag_name IN (...)` 反查，
 * 走 `ix_post_has_tag_tag_name`，三条合计约 200 ms 且一批只付一次。
 *
 * 优先级仍然只有一处定义 —— `FORMAT_TAGS` 的数组序，两个函数都从它读。
 */
export function formatOf(
  id: number,
  sets: ReadonlyMap<Exclude<Format, 'illust'>, ReadonlySet<number>>,
): Format {
  for (const [format] of FORMAT_TAGS)
    if (sets.get(format)?.has(id))
      return format
  return 'illust'
}
