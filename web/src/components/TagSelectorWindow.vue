<script setup lang="ts">
import { selectedPostIdSet, showPostDetail, tagSelectorWindowRef } from '@/shared'

const selectedPostId = computed<number | undefined>(() => {
  const selected = selectedPostIdSet.value.values().next().value
  if (selected) {
    return selected
  }
  return showPostDetail.value?.id
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
