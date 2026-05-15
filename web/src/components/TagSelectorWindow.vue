<script setup lang="ts">
import { useFocusedPost } from '@/composables/useFocusedPost'
import { tagSelectorWindowRef } from '@/shared'

const { focusedPostId } = useFocusedPost()
</script>

<template>
  <FloatWindow
    ref="tagSelectorWindowRef"
    :safe-margin="16"
  >
    <TagSelector
      :post-id="focusedPostId"
    />
  </FloatWindow>
</template>
