<script setup lang="ts">
import type { PostHasTagPublic, TagWithCountPublic } from '@/api'
import { computed } from 'vue'
import { naturalizeTagName } from '@/utils'

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
  // Foreground mixes the tag color with the theme foreground so dark tag
  // colors stay readable in dark mode and bright ones stay readable in light.
  return {
    backgroundColor: `color-mix(in oklab, ${tagColor} 24%, transparent)`,
    color: `color-mix(in oklab, ${tagColor} 55%, var(--p-fg) 45%)`,
    borderColor: `color-mix(in oklab, ${tagColor} 32%, transparent)`,
  }
})

const tagName = computed(() => {
  if (isTagWithCount(data.value)) {
    return data.value.name
  }
  if (isPostHasTag(data.value)) {
    return data.value.tagInfo.name
  }
  return ''
})

// 本地化显示名优先（后端 translatedName）；无翻译时兜底为去下划线的
// 自然英文。hover title 始终展示原始下划线英文名，便于核对/复制。
const label = computed(() => {
  const translated = isTagWithCount(data.value)
    ? data.value.translatedName
    : isPostHasTag(data.value)
      ? data.value.tagInfo.translatedName
      : null
  return translated ?? naturalizeTagName(tagName.value)
})
</script>

<template>
  <PTag
    variant="soft"
    tone="primary"
    size="sm"
    :style="colorStyle"
    :title="tagName"
  >
    {{ label }}
  </PTag>
</template>
