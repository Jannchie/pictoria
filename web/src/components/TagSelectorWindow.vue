<script setup lang="ts">
import { selectedPostIdSet, tagSelectorWindowRef } from '@/shared'

const selectedPostId = computed(() => {
  if (selectedPostIdSet.value.size === 0) {
    return
  }
  return selectedPostIdSet.value.values().next().value
})
</script>

<template>
  <FloatWindow
    ref="tagSelectorWindowRef"
    :safe-margin="16"
  >
    <TagSelector
      :post-id="selectedPostId"
    />
  </FloatWindow>
</template>
