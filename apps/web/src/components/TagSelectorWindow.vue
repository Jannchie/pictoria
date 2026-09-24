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

// Adding the first / removing the last tag swaps the panel's "Add tag" button
// for another one, so the opener is gone when the window closes: fall back to
// whichever opener exists now.
function currentOpener(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-tag-editor-opener]')
}
</script>

<template>
  <PFloatWindow
    :ref="bindTagSelectorWindow"
    :safe-margin="16"
    role="dialog"
    :aria-label="$t('tagSelector.title')"
    :return-focus="currentOpener"
  >
    <TagSelector
      :post-id="focusedPostId"
    />
  </PFloatWindow>
</template>
