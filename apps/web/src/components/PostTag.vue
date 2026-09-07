<script setup lang="ts">
import type { PostHasTagPublic, TagWithCountPublic } from '@/api'
import { computed } from 'vue'
import { naturalizeTagName } from '@/utils'

const props = defineProps<{
  data: TagWithCountPublic | PostHasTagPublic
  /** 自动打的标签：同一堆里和手动标签混排，靠虚线边框 + 星标区分。 */
  auto?: boolean
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
    // 无分类色的自动标签也得有条看得见的虚线，否则和手动标签只剩星标可分。
    return props.auto ? { borderColor: 'var(--p-border-strong)' } : undefined
  }
  // Foreground mixes the tag color with the theme foreground so dark tag
  // colors stay readable in dark mode and bright ones stay readable in light.
  // 自动标签底色更淡、边框更实：主次靠填充深浅拉开，颜色仍是它自己的分类色。
  return {
    backgroundColor: `color-mix(in oklab, ${tagColor} ${props.auto ? 8 : 18}%, transparent)`,
    color: `color-mix(in oklab, ${tagColor} 60%, var(--p-fg) 40%)`,
    borderColor: `color-mix(in oklab, ${tagColor} ${props.auto ? 45 : 28}%, transparent)`,
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
  <!-- Square-ish corners (radius-sm) rather than a pill: dozens of tags per
       post read better as a typeset list than as a field of capsules. -->
  <PTag
    variant="soft"
    tone="neutral"
    size="sm"
    class="post-tag max-w-full"
    :class="{ 'post-tag--auto': auto }"
    :style="colorStyle"
    :title="tagName"
  >
    <i
      v-if="auto"
      class="i-tabler-sparkles op-70 shrink-0"
    />
    <!-- 超长标签名（danbooru 的角色全名能到几十字）在受限容器里必须截断,
         否则会撑破所在格子盖住旁边的内容。完整名字仍在 title 上。 -->
    <span class="truncate">{{ label }}</span>
  </PTag>
</template>

<style scoped>
.p-tag.post-tag {
  border-radius: var(--p-radius-sm);
  border-color: var(--p-border-subtle);
}
/* 虚线边框是主次的主要信号：一眼扫过去，实心底色的是人打的。 */
.p-tag.post-tag--auto {
  border-style: dashed;
}
</style>
