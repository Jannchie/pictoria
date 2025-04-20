<script setup lang="tsx">
import type { PostHasTagPublic, TagWithCountPublic } from '@/api'
import { Tag } from '@roku-ui/vue'

const props = defineProps<{
  data: TagWithCountPublic | PostHasTagPublic
}>()
function isTagWithCount(datum: any): datum is TagWithCountPublic {
  return 'count' in datum
}
function isPostHasTag(datum: any): datum is PostHasTagPublic {
  return 'tagInfo' in datum
}
const data = computed(() => {
  return props.data
})
</script>

<template>
  <Tag
    v-if="isTagWithCount(data)"
    variant="light"
    size="sm"
    rounded="lg"
    :color="data.group?.color"
  >
    {{ data.name }}
  </Tag>
  <Tag
    v-else-if="isPostHasTag(data)"
    variant="light"
    size="sm"
    rounded="lg"
    :color="data.tagInfo.group?.color"
  >
    {{ data.tagInfo.name }}
  </Tag>
</template>
