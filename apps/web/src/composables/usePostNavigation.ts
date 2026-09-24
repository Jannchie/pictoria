import type { MaybeRefOrGetter } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { computed, toRaw, toValue } from 'vue'
import { useI18n } from 'vue-i18n'
import { currentPostList } from '@/shared'
import { announce } from '@/shared/announce'

/**
 * 在当前浏览列表里前后翻一张。
 *
 * ←→ 热键、详情页的翻页竖条、全屏查看器的翻页竖条，此前各自写了一遍「在
 * `currentPostList` 里 findIndex，然后 ±1 并夹住两端」—— 加上
 * [[useAdjacentImagePreload]] 里的第四份。判定散在四处的直接后果是它们会各自
 * 漂移：按钮的可用性和真正能不能翻，靠的是两段独立写出来的边界条件。
 *
 * 列表最多有二十多万条，`currentPostList` 又是深层 `ref`，所以扫描走 `toRaw`
 * 避开逐元素的响应式包装，并且一次扫描的结果同时喂给 `canPrev` / `canNext` /
 * `neighbor`。
 */
export function usePostNavigation(postId: MaybeRefOrGetter<number | undefined>) {
  /** 当前图在列表中的下标，-1 表示不在列表里（例如直接输 URL 进来的）。 */
  const index = computed(() => {
    const id = toValue(postId)
    if (id === undefined) {
      return -1
    }
    return toRaw(currentPostList.value).findIndex(p => p.id === id)
  })

  /** 列表长度，用于「n / total」式的播报。 */
  const total = computed(() => currentPostList.value.length)

  const canPrev = computed(() => index.value > 0)
  const canNext = computed(() => index.value >= 0 && index.value < currentPostList.value.length - 1)

  /** 相邻的那张，越界时为 undefined —— 调用方据此决定翻不翻。 */
  function neighbor(delta: -1 | 1) {
    if (index.value === -1) {
      return
    }
    return currentPostList.value[index.value + delta]
  }

  return { index, total, canPrev, canNext, neighbor }
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
