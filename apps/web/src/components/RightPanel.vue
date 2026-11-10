<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useFocusedPost } from '@/composables/useFocusedPost'
import { usePostQuery } from '@/composables/usePostQuery'
import { visiblePostList } from '@/shared/visiblePosts'

const route = useRoute()
const { focusedPostId, mode } = useFocusedPost()
const { data: postData, isError: postFailed } = usePostQuery(focusedPostId)

// While annotating, this pane is the annotation history — that is the only route
// where it means anything, and it has to win over the post branches rather than
// live inside the nothing-selected fallback: the focus mode is driven by the
// GALLERY selection, which survives navigating here, so a post picked before
// entering the session would otherwise keep its detail panel on screen and the
// history would never appear.
const isAnnotating = computed(() => route.name === 'annotate')

// The detail of a just-selected post is a request away; the list row it was
// picked from is not. Until the detail lands, show that row instead of falling
// back to the overview (which flashed in between every click).
const listRow = computed(() => {
  const id = focusedPostId.value
  if (id === undefined) {
    return
  }
  return visiblePostList.value.find(p => p.id === id)
})
</script>

<template>
  <AnnotationTimeline v-if="isAnnotating" />
  <!-- A failed detail (deleted meanwhile) falls through to the overview. -->
  <template v-else-if="mode === 'single' && !(postFailed && !postData)">
    <PostDetailPanel
      v-if="postData"
      :post="postData"
    />
    <PostDetailPlaceholder
      v-else-if="listRow"
      :post="listRow"
    />
    <div
      v-else
      class="flex h-full items-center justify-center"
      role="status"
      :aria-label="$t('post.panel.loadingDetail')"
    >
      <i class="i-tabler-loader text-fg-subtle animate-spin" aria-hidden="true" />
    </div>
  </template>
  <PostMultiSelectPanel
    v-else-if="mode === 'multi'"
  />
  <!-- Nothing selected: read the current view instead of asking for a click. -->
  <GalleryOverviewPanel v-else />
</template>
