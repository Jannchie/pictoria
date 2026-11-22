<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetExtensionCount } from '@/api'
import { facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'

const { t } = useI18n()

const { selected: selectedExtensions, has: hasExt, toggle, countQuery, pct, opened } = useFacetFilter<string, { extension: string, count: number }>({
  field: 'extension',
  countKind: 'extension',
  fetchCounts: async (filter) => {
    const resp = await v2GetExtensionCount({ body: filter })
    return resp.data
  },
})

const countByExtension = computed(() => {
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

  // 合并已选择的扩展名（可能不在API结果中）并去重
  return [...new Set([...apiExtensions, ...selectedExtensions.value])]
})

const btnText = computed(() => {
  const item = selectedExtensions.value
  return item.length === 0 ? t('filter.extension') : item.join(', ')
})
function extensionCount(extension: string): number | undefined {
  return countByExtension.value[extension]
}

/** Spoken / typeahead name: the bare extension, or "No extension". */
function extensionLabel(extension: string): string {
  return extension === '' ? t('filter.noExtension') : extension
}

const listbox = useTemplateRef<{ el: HTMLElement | null }>('listbox')
useFacetListbox(() => listbox.value?.el)
const autofocusIndex = computed(() => initialOptionIndex(extensions.value, hasExt))
const triggerLabel = computed(() => facetTriggerLabel(t, t('filter.extension'), selectedExtensions.value.map(extensionLabel)))
function optionLabel(extension: string) {
  return facetOptionLabel(t, extensionLabel(extension), countQuery.data.value ? (countByExtension.value[extension] ?? 0) : undefined)
}
</script>

<template>
  <div class="relative">
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="selectedExtensions.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <i class="i-tabler-file" aria-hidden="true" />
        <span class="flex-grow">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <PFacetList
          ref="listbox"
          :aria-label="$t('filter.extension')"
          class="p-popover-panel min-w-52"
          :items="extensions"
          :selected="hasExt"
          :option-label="optionLabel"
          :typeahead="extensionLabel"
          :autofocus-index="autofocusIndex"
          :count="extensionCount"
          :share="pct"
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
        </PFacetList>
      </template>
    </PPopover>
  </div>
</template>
