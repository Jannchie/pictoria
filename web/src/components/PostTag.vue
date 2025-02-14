<script setup lang="tsx">
import type { PostHasTagPublic, TagWithCountPublic } from '@/api'
import { useTagGroup } from '@/shared'

const props = defineProps<{
  data: TagWithCountPublic | PostHasTagPublic
}>()

const data = computed(() => props.data)
const tagGroup = useTagGroup()
function getGroupColor(group_id: number | undefined) {
  return tagGroup.value.find(g => g.id === group_id)?.color
}
</script>

<template>
  <Tag
    class="user-select-auto cursor-pointer"
    rounded="lg"
    :color="getGroupColor(data.tag_info.group?.id)"
  >
    {{ data.tag_info.name }}
  </Tag>
</template>
