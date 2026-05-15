import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { selectedPostIdSet, showPostDetail } from '@/shared'

export type FocusMode = 'single' | 'multi' | 'none'

export function useFocusedPost() {
  const route = useRoute()

  const focusedPostId = computed<number | undefined>(() => {
    if (route.name === 'post') {
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
    return undefined
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
