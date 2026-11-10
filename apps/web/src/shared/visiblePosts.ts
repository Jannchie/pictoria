import { computed } from 'vue'
import { router } from '@/router'
import { currentPostList, similarPostList } from './state'

/**
 * The ordered posts the user is looking at: the similar-posts grid on a post
 * page, otherwise the gallery list. The right-pane panels resolve selected ids
 * to rows through it (the post page's prev/next keeps using `currentPostList`).
 */
export const visiblePostList = computed(() =>
  router.currentRoute.value.name === 'post' ? similarPostList.value : currentPostList.value)
