<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { useFocusedPost } from '@/composables/useFocusedPost'
import { tagSelectorWindowRef } from '@/shared'

const { focusedPostId } = useFocusedPost()

// Bind the FloatWindow instance into the shared ref (openTagSelectorWindow
// calls .toggle() on it). A function ref rather than a string ref so the
// imported ref is seen as read by the type-checker (noUnusedLocals).
// Non-modal floating dialog. PFloatWindow owns the layer (Escape closes,
// focus goes to TagSelector's [data-autofocus] search input on open and back
// to the opener on close) and drags from TagSelector's [data-drag-handle]
// header row.
function bindTagSelectorWindow(el: Element | ComponentPublicInstance | null) {
  tagSelectorWindowRef.value = el
}
</script>

<template>
  <PFloatWindow
    :ref="bindTagSelectorWindow"
    :safe-margin="16"
    role="dialog"
    :aria-label="$t('tagSelector.title')"
  >
    <TagSelector
      :post-id="focusedPostId"
    />
  </PFloatWindow>
</template>
