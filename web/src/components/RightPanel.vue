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
  <div
    v-else
    class="text-xs text-fg-subtle px-6 text-center flex flex-col gap-2 h-full items-center justify-center"
  >
    <i class="i-tabler-photo-search text-3xl op50" aria-hidden="true" />
    <div class="text-sm text-fg-muted">
      {{ $t('rightPanel.empty') }}
    </div>
    <div class="text-balance">
      {{ $t('rightPanel.emptyHint') }}
    </div>
  </div>
</template>
