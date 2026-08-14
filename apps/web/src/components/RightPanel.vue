<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useFocusedPost } from '@/composables/useFocusedPost'
import { usePostQuery } from '@/composables/usePostQuery'

const route = useRoute()
const { focusedPostId, mode } = useFocusedPost()
const { data: postData } = usePostQuery(focusedPostId)

// While annotating, this pane is the annotation history — that is the only route
// where it means anything, and it has to win over the post branches rather than
// live inside the nothing-selected fallback: the focus mode is driven by the
// GALLERY selection, which survives navigating here, so a post picked before
// entering the session would otherwise keep its detail panel on screen and the
// history would never appear.
const isAnnotating = computed(() => route.name === 'annotate')
</script>

<template>
  <AnnotationTimeline v-if="isAnnotating" />
  <PostDetailPanel
    v-else-if="mode === 'single' && postData"
    :post="postData"
  />
  <PostMultiSelectPanel
    v-else-if="mode === 'multi'"
  />
  <!-- Nothing selected: read the current view instead of asking for a click. -->
  <GalleryOverviewPanel v-else />
</template>
