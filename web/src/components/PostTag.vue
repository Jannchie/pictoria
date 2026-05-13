<script setup lang="ts">
import type { PostHasTagPublic, TagWithCountPublic } from '@/api'
import { computed } from 'vue'

const props = defineProps<{
  data: TagWithCountPublic | PostHasTagPublic
}>()
function isTagWithCount(datum: any): datum is TagWithCountPublic {
  return 'count' in datum
}
function isPostHasTag(datum: any): datum is PostHasTagPublic {
  return 'tagInfo' in datum
}
const data = computed(() => props.data)

const colorStyle = computed(() => {
  const tagColor = isTagWithCount(data.value)
    ? data.value.group?.color
    : isPostHasTag(data.value)
      ? data.value.tagInfo.group?.color
      : null
  if (!tagColor) {
    return
  }
  return {
    backgroundColor: `color-mix(in srgb, ${tagColor} 22%, transparent)`,
    color: tagColor,
  }
})

const label = computed(() => {
  if (isTagWithCount(data.value)) {
    return data.value.name
  }
  if (isPostHasTag(data.value)) {
    return data.value.tagInfo.name
  }
  return ''
})
</script>

<template>
  <PTag
    variant="soft"
    tone="primary"
    size="sm"
    :style="colorStyle"
  >
    {{ label }}
  </PTag>
</template>
