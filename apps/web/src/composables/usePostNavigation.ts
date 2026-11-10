import type { MaybeRefOrGetter } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import { currentPostList, postNavContext } from '@/shared'
import { announce } from '@/shared/announce'

/**
 * 在当前浏览列表里前后翻一张。
 *
 * ←→ 热键、详情页的翻页竖条、全屏查看器的翻页竖条，此前各自写了一遍「在
 * `currentPostList` 里 findIndex，然后 ±1 并夹住两端」—— 加上
 * [[useAdjacentPostPrefetch]] 里的第四份。判定散在四处的直接后果是它们会各自
 * 漂移：按钮的可用性和真正能不能翻，靠的是两段独立写出来的边界条件。
 *
 * 列表最多有二十多万条（`currentPostList` 是 `shallowRef`，元素是原始对象，
 * 扫描不经过响应式代理），一次扫描的结果同时喂给 `canPrev` / `canNext` /
 * `neighbor`。
 */
export function usePostNavigation(postId: MaybeRefOrGetter<number | undefined>) {
  /**
   * 翻页走哪张列表：画廊列表里有这张就走画廊；否则走「从哪张图的相似图点进来的」
   * 那张相似图列表（[[postNavContext]]）；都没有则 `source = null`，不能翻。
   */
  const located = computed(() => {
    const id = toValue(postId)
    if (id === undefined) {
      return { source: null, list: currentPostList.value, index: -1 } as const
    }
    const i = currentPostList.value.findIndex(p => p.id === id)
    if (i !== -1) {
      return { source: 'gallery', list: currentPostList.value, index: i } as const
    }
    const ctx = postNavContext.value
    const j = ctx ? ctx.list.findIndex(p => p.id === id) : -1
    if (ctx && j !== -1) {
      return { source: ctx.kind, list: ctx.list, index: j } as const
    }
    return { source: null, list: currentPostList.value, index: -1 } as const
  })

  /** 当前图在翻页列表中的下标，-1 表示不在任何列表里（例如直接输 URL 进来的）。 */
  const index = computed(() => located.value.index)
  const list = computed(() => located.value.list)
  const source = computed(() => located.value.source)

  /** 列表长度，用于「n / total」式的播报。 */
  const total = computed(() => list.value.length)

  const canPrev = computed(() => index.value > 0)
  const canNext = computed(() => index.value >= 0 && index.value < list.value.length - 1)

  /** 相邻的那张，越界时为 undefined —— 调用方据此决定翻不翻。 */
  function neighbor(delta: -1 | 1) {
    if (index.value === -1) {
      return
    }
    return list.value[index.value + delta]
  }

  return { index, total, list, source, canPrev, canNext, neighbor }
}

/** 连按 ←→ 时只播报停下来的那一张。 */
const NAV_ANNOUNCE_DELAY = 250

/**
 * 翻页后的读屏播报：「n / total — 文件名」（polite，防抖）。详情页和全屏查看器
 * 共用；两者同时挂载时只有真正执行翻页的那一方调用它，不会重复播报。
 */
export function usePostNavAnnounce() {
  const { t } = useI18n()
  return useDebounceFn((post: { fileName: string, extension: string }, position: number, total: number) => {
    const name = `${post.fileName}.${post.extension}`
    announce(t('post.navAnnounce', { n: position, total, name }))
  }, NAV_ANNOUNCE_DELAY)
}
