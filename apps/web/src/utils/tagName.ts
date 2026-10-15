/**
 * 无本地化翻译时的展示兜底：把数据库的下划线 tag 名还原成自然英文
 * （green_eyes → green eyes）。筛选 / API 调用仍必须用原始下划线名。
 *
 * 独立成叶子模块：`@/utils` 的 barrel 会把 app 状态一起拉进来，而
 * `shared/postFilter` / `utils/paletteRows` 要保持可以脱离 app 单测。
 */
export function naturalizeTagName(name: string): string {
  return name.replaceAll('_', ' ')
}
