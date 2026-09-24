<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import type { ScorerUi } from '@/shared/scorers'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { activateOptionOnKey, facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'
import { WAIFU_LEVEL_RGB } from '@/shared'

/** One popover row: a score bucket on the shared A–E quality scale. */
interface BucketDef {
  level: string // 'A' | 'B' | 'C' | 'D' | 'E' | 'UNSCORED'
  labelKey: string
  range: string // e.g. '0.8 – 1.0'
}

const props = defineProps<{
  /** The `postFilter` array facet this filter drives. */
  field: ScorerUi['levelsField']
  countKind: 'waifu' | 'silva' | 'silvaLuna'
  fetchCounts: (filter: PostFilterValue) => Promise<{ bucket: string, count: number }[] | undefined>
  /** Bucket rows in popover order (top → bottom). */
  buckets: BucketDef[]
  /** Button icon class, e.g. 'i-tabler-crown'. */
  icon: string
  /** Button label while nothing is selected (already translated). */
  label: string
  /** Prefix before the selected levels, e.g. 'Waifu: A, B'. */
  selectedPrefix: string
}>()

// Shared A–E ramp (WAIFU_LEVEL_RGB) plus a muted dot for the unscored bucket.
const LEVEL_DOT_RGB: Record<string, string> = {
  ...Object.fromEntries(WAIFU_LEVEL_RGB.map(b => [b.level, b.rgb])),
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

const { selected: selectedLevels, has: hasLevel, toggle, countQuery, pct, opened } = useFacetFilter<string, { bucket: string, count: number }>({
  field: props.field,
  countKind: props.countKind,
  fetchCounts: props.fetchCounts,
})

const bucketCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = Object.fromEntries(props.buckets.map(b => [b.level, 0]))
  const data = countQuery.data
  if (data.value) {
    for (const d of data.value) {
      out[d.bucket] = d.count
    }
  }
  return out
})

const btnText = computed(() => {
  const item = selectedLevels.value
  return item.length === 0 ? props.label : `${props.selectedPrefix}: ${item.join(', ')}`
})

const { t } = useI18n()

/** Short spoken name of a level: the letter, or "Unscored". */
function levelName(level: string): string {
  return level === 'UNSCORED' ? t('common.unscored') : level
}

const listbox = useTemplateRef<HTMLElement>('listbox')
useFacetListbox(listbox)
const autofocusIndex = computed(() => initialOptionIndex(props.buckets.map(b => b.level), hasLevel))
const triggerLabel = computed(() => facetTriggerLabel(t, props.label, selectedLevels.value.map(levelName)))
function optionLabel(bucket: BucketDef) {
  const name = bucket.range
    ? t('filter.bucketOption', { level: bucket.level, name: t(bucket.labelKey), range: bucket.range })
    : levelName(bucket.level)
  return facetOptionLabel(t, name, countQuery.data.value ? bucketCounts.value[bucket.level] : undefined)
}
</script>

<template>
  <div class="relative">
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="selectedLevels.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <i :class="icon" aria-hidden="true" />
        <span>{{ btnText }}</span>
      </PButton>
      <template #content>
        <div
          ref="listbox"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="label"
          class="p-popover-panel max-w-sm w-max"
        >
          <!-- Typeahead on the letter: "b" jumps to bucket B. -->
          <div
            v-for="(bucket, i) in buckets"
            :key="bucket.level"
            role="option"
            :aria-selected="hasLevel(bucket.level)"
            :aria-label="optionLabel(bucket)"
            :data-typeahead="levelName(bucket.level)"
            :data-autofocus="i === autofocusIndex || undefined"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2 focus-visible:[outline-offset:-2px]"
            @click="toggle(bucket.level)"
            @keydown="activateOptionOnKey($event, () => toggle(bucket.level))"
          >
            <PCheckbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasLevel(bucket.level)"
              inert
              aria-hidden="true"
            />
            <div class="flex flex-grow gap-2 items-center">
              <span
                class="rounded-full flex-shrink-0 h-3 w-3"
                aria-hidden="true"
                :style="{ backgroundColor: `rgb(${LEVEL_DOT_RGB[bucket.level]})` }"
              />
              <span
                class="font-bold"
                :class="{ 'text-fg-subtle italic font-normal': bucket.level === 'UNSCORED' }"
              >
                {{ bucket.level === 'UNSCORED' ? $t('common.unscored') : bucket.level }}
              </span>
              <span
                v-if="bucket.range"
                class="text-fg-muted whitespace-nowrap"
              >
                {{ $t(bucket.labelKey) }} ({{ bucket.range }})
              </span>
            </div>
            <div
              v-if="bucketCounts[bucket.level] || hasLevel(bucket.level)"
              class="font-mono inline-flex flex-shrink-0 tabular-nums"
            >
              <span class="text-right flex-shrink-0 w-10" :class="bucketCounts[bucket.level] ? 'text-fg-muted' : 'text-fg-subtle'">{{ bucketCounts[bucket.level] }}</span>
              <span v-if="bucketCounts[bucket.level]" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ pct(bucketCounts[bucket.level]) }}%</span>
            </div>
          </div>
        </div>
      </template>
    </PPopover>
  </div>
</template>
