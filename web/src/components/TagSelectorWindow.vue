<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { useFocusedPost } from '@/composables/useFocusedPost'
import { tagSelectorWindowRef } from '@/shared'

const { focusedPostId } = useFocusedPost()

// Bind the FloatWindow instance into the shared ref (openTagSelectorWindow
// calls .toggle() on it). A function ref rather than a string ref so the
// imported ref is seen as read by the type-checker (noUnusedLocals).
function bindTagSelectorWindow(el: Element | ComponentPublicInstance | null) {
  tagSelectorWindowRef.value = el
}
</script>

<template>
  <PFloatWindow
    :ref="bindTagSelectorWindow"
    :safe-margin="16"
  >
    <TagSelector
      :post-id="focusedPostId"
    />
  </PFloatWindow>
</template>
