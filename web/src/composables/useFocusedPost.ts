import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { selectedPostIdSet, showPostDetail } from '@/shared'

export type FocusMode = 'single' | 'multi' | 'none'

export function useFocusedPost() {
  const route = useRoute()

  const focusedPostId = computed<number | undefined>(() => {
    if (route.name === 'post') {
      // 详情页点击相似图会把它写入 selectedPostIdSet，侧边栏跟随单选项切换。
      if (selectedPostIdSet.value.size === 1) {
        const only = selectedPostIdSet.value.values().next().value
        if (typeof only === 'number') {
          return only
        }
      }
      // 多选（如 Ctrl 点选多张相似图）时不返回 id，交给 mode 判定为
      // 'multi'，侧边栏切换到多选面板。
      if (selectedPostIdSet.value.size > 1) {
        return
      }
      // 没有选中项时回退到 URL 主图。
      const raw = route.params.postId
      const id = Number.parseInt(typeof raw === 'string' ? raw : '')
      return Number.isFinite(id) ? id : undefined
    }
    if (showPostDetail.value) {
      return showPostDetail.value.id
    }
    if (selectedPostIdSet.value.size === 1) {
      const only = selectedPostIdSet.value.values().next().value
      return typeof only === 'number' ? only : undefined
    }
  })

  const mode = computed<FocusMode>(() => {
    if (focusedPostId.value !== undefined) {
      return 'single'
    }
    if (selectedPostIdSet.value.size > 1) {
      return 'multi'
    }
    return 'none'
  })

  return { focusedPostId, mode }
}
