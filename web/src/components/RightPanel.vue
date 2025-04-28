<script setup lang="ts">
import type { PostDetailPublic } from '@/api'

import { selectedPostIdSet, showPostDetail } from '@/shared'
import { computed } from 'vue'

function isPost(datum: any): datum is PostDetailPublic {
  return 'filePath' in datum
}
const id = computed<number | undefined>(() => {
  const selected = selectedPostIdSet.value.values().next().value
  if (selected) {
    return selected
  }
  else if (showPostDetail.value) {
    return showPostDetail.value.id
  }
})
const { data: postData } = usePostQuery(id)
const data = computed(() => {
  return postData.value ? [postData.value] : []
})
</script>

<template>
  <template
    v-for="datum, i of data"
    :key="i"
  >
    <PostDetailPanel
      v-if="isPost(datum)"
      :post="datum"
    />
    <div v-else>
      {{ datum }}
    </div>
  </template>
</template>
