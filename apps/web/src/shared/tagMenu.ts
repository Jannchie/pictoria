import type { PMenuItem } from '@/ui'
import { i18n } from '@/locale'
import { router } from '@/router'
import { naturalizeTagName } from '@/utils/tagName'
import { isGalleryRoute } from './galleryView'
import { postFilter } from './state'

/**
 * 按标签筛选画廊：`only` 时只留这一个标签，否则追加（已在筛选里就不动）。不在画廊
 * 路由上（标签页、独立详情页）时没有画廊可筛，带着筛选回画廊首页。
 *
 * 标签页和详情面板的标签菜单 / Mod+点击共用这一份。
 */
export function filterByTag(name: string, only: boolean): void {
  const current = postFilter.value.tags
  postFilter.value.tags = only ? [name] : current.includes(name) ? current : [...current, name]
  if (!isGalleryRoute(router.currentRoute.value)) {
    void router.push('/')
  }
}

/** 标签菜单里两个筛选项的 value，`onSelect` 里交给 `runTagFilterAction`。 */
export type TagFilterAction = 'filter' | 'filterOnly'

/**
 * 标签菜单的开头：标签名（译名优先）标题行 + 「加入筛选」「只看这个」两项。调用方
 * 在后面接自己的项。
 */
export function tagMenuHead(tag: { name: string, translatedName?: string | null }): PMenuItem[] {
  const t = i18n.global.t
  return [
    { role: 'label', title: tag.translatedName ?? naturalizeTagName(tag.name) },
    { title: t('post.panel.tagFilter'), icon: 'i-tabler-filter-plus', value: 'filter' satisfies TagFilterAction },
    { title: t('post.panel.tagFilterOnly'), icon: 'i-tabler-filter', value: 'filterOnly' satisfies TagFilterAction },
  ]
}

/** 处理 `tagMenuHead` 的两个筛选项；是其中之一就执行并返回 true。 */
export function runTagFilterAction(value: unknown, name: string): boolean {
  if (value === 'filter' || value === 'filterOnly') {
    filterByTag(name, value === 'filterOnly')
    return true
  }
  return false
}
