<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetExtensionCount } from '@/api'
import { activateOptionOnKey, facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'

const { t } = useI18n()

const { selected: ratingFilterData, has: hasExt, toggle, countQuery, pct, opened } = useFacetFilter<string, { extension: string, count: number }>({
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

/** Spoken / typeahead name: the bare extension, or "No extension". */
function extensionLabel(extension: string): string {
  return extension === '' ? t('filter.noExtension') : extension
}

const listbox = useTemplateRef<HTMLElement>('listbox')
useFacetListbox(listbox)
const autofocusIndex = computed(() => initialOptionIndex(extensions.value, hasExt))
const triggerLabel = computed(() => facetTriggerLabel(t, t('filter.extension'), ratingFilterData.value.map(extensionLabel)))
function optionLabel(extension: string) {
  return facetOptionLabel(t, extensionLabel(extension), countQuery.data.value ? (scoreCountList.value[extension] ?? 0) : undefined)
}
</script>

<template>
  <div class="relative">
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="ratingFilterData.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <i class="i-tabler-file" aria-hidden="true" />
        <span class="flex-grow">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div
          ref="listbox"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="$t('filter.extension')"
          class="p-popover-panel min-w-52"
        >
          <div
            v-for="(ext, i) in extensions"
            :key="ext"
            role="option"
            :aria-selected="hasExt(ext)"
            :aria-label="optionLabel(ext)"
            :data-typeahead="extensionLabel(ext)"
            :data-autofocus="i === autofocusIndex || undefined"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2 focus-visible:[outline-offset:-2px]"
            @click="toggle(ext)"
            @keydown="activateOptionOnKey($event, () => toggle(ext))"
          >
            <PCheckbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasExt(ext)"
              inert
              aria-hidden="true"
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
    </PPopover>
  </div>
</template>
