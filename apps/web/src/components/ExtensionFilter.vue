<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetExtensionCount } from '@/api'
import { useFacetCounts, useFacetFilter } from '@/composables/useFacetFilter'
import FacetFilterPopover from './FacetFilterPopover.vue'

const { t } = useI18n()

const { selected: selectedExtensions, has: hasExt, toggle, countQuery, pct, opened } = useFacetFilter<string, { extension: string, count: number }>({
  field: 'extension',
  countKind: 'extension',
  fetchCounts: async (filter) => {
    const resp = await v2GetExtensionCount({ body: filter })
    return resp.data
  },
})
const { count: extensionCount, optionCount } = useFacetCounts(countQuery.data, d => d.extension)

// 确保已选择的扩展名选项始终显示在列表中
const extensions = computed(() => {
  // 从API获取的扩展名列表
  const apiExtensions = countQuery.data.value?.map(d => d.extension) ?? []

  // 合并已选择的扩展名（可能不在API结果中）并去重
  return [...new Set([...apiExtensions, ...selectedExtensions.value])]
})

/**
 * Spoken / typeahead name: the bare extension, or "No extension". The trigger
 * text shows the bare extensions instead (`String`), so "" stays empty there.
 */
function extensionLabel(extension: string): string {
  return extension === '' ? t('filter.noExtension') : extension
}
</script>

<template>
  <FacetFilterPopover
    v-model:opened="opened"
    :label="$t('filter.extension')"
    :items="extensions"
    :selection="selectedExtensions"
    :has="hasExt"
    :value-name="extensionLabel"
    :value-text="String"
    :count="extensionCount"
    :option-count="optionCount"
    :share="pct"
    icon="i-tabler-file"
    text-class="flex-grow"
    panel-class="min-w-52"
    @toggle="toggle"
  >
    <template #default="{ item: ext }">
      <div class="flex flex-grow gap-1 items-center">
        <template v-if="ext === ''">
          <span class="text-fg-subtle italic">{{ $t('filter.noExtension') }}</span>
        </template>
        <template v-else>
          <span class="font-mono">.{{ ext }}</span>
        </template>
      </div>
    </template>
  </FacetFilterPopover>
</template>
