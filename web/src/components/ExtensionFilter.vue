<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetExtensionCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'

const { t } = useI18n()

const { selected: ratingFilterData, has: hasExt, toggle, countQuery, pct } = useFacetFilter<string, { extension: string, count: number }>({
  field: 'extension',
  countKind: 'extension',
  fetchCounts: async (filter) => {
    const resp = await v2GetExtensionCount({ body: filter })
    return resp.data
  },
})

const scoreCountList = computed(() => {
  const resp: Record<string, number> = {}
  const data = countQuery.data
  if (data.value) {
    for (const d of data.value) {
      resp[d.extension] = d.count
    }
  }
  return resp
})

// 确保已选择的扩展名选项始终显示在列表中
const extensions = computed(() => {
  // 从API获取的扩展名列表
  const apiExtensions = countQuery.data.value?.map(d => d.extension) ?? []

  // 已选择的扩展名（可能不在API结果中）
  const selectedExtensions = ratingFilterData.value

  // 合并并去重
  return [...new Set([...apiExtensions, ...selectedExtensions])]
})

const btnText = computed(() => {
  const item = ratingFilterData.value
  return item.length === 0 ? t('filter.extension') : item.map(s => getExtensionName(s)).join(', ')
})
function getExtensionName(extension: string) {
  return extension
}
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <i class="i-tabler-file" />
        <span class="flex-grow">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div
          class="p-popover-panel min-w-52"
        >
          <div
            v-for="ext in extensions"
            :key="ext"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
            @pointerdown="toggle(ext)"
          >
            <Checkbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasExt(ext)"
            />
            <div class="flex flex-grow gap-1 items-center">
              <template v-if="ext === ''">
                <span class="text-fg-subtle italic">{{ $t('filter.noExtension') }}</span>
              </template>
              <template v-else>
                <span class="font-mono">.{{ getExtensionName(ext) }}</span>
              </template>
            </div>
            <div
              v-if="scoreCountList[ext] || hasExt(ext)"
              class="font-mono inline-flex flex-shrink-0 tabular-nums"
            >
              <span class="text-right flex-shrink-0 w-10" :class="scoreCountList[ext] ? 'text-fg-muted' : 'text-fg-subtle'">{{ scoreCountList[ext] || 0 }}</span>
              <span v-if="scoreCountList[ext]" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ pct(scoreCountList[ext]) }}%</span>
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
