import type { WatchSource } from 'vue'
import { watch } from 'vue'
import { currentPostList } from '@/shared'
import { getPostImageURL } from '@/utils'

/**
 * 预加载当前帖子在 currentPostList 中前后相邻的原图，使详情页 ←→ 切换瞬间完成
 * （命中浏览器缓存）。每当当前帖子变化时，预取前一张和后一张。
 */
export function useAdjacentImagePreload(currentId: WatchSource<number | undefined>) {
  watch(currentId, (id) => {
    if (id === undefined || !Number.isFinite(id)) {
      return
    }
    const list = currentPostList.value
    const idx = list.findIndex(p => p.id === id)
    if (idx === -1) {
      return
    }
    for (const delta of [-1, 1]) {
      const neighbor = list[idx + delta]
      if (neighbor) {
        const img = new Image()
        img.src = getPostImageURL(neighbor)
      }
    }
  }, { immediate: true })
}
