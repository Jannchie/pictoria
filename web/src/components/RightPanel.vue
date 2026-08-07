<script setup lang="ts">
import { usePostQuery } from '@/composables'
import { useFocusedPost } from '@/composables/useFocusedPost'

const { focusedPostId, mode } = useFocusedPost()
const { data: postData } = usePostQuery(focusedPostId)
</script>

<template>
  <PostDetailPanel
    v-if="mode === 'single' && postData"
    :post="postData"
  />
  <PostMultiSelectPanel
    v-else-if="mode === 'multi'"
  />
  <!-- Nothing selected: read the current view instead of asking for a click. -->
  <GalleryOverviewPanel v-else />
</template>
