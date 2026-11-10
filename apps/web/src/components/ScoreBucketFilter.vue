<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import type { ScorerUi } from '@/shared/scorers'
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetSilvaBucketCount, v2GetSilvaLunaBucketCount, v2GetWaifuBucketCount } from '@/api'
import { facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'
import { bucketRows, WAIFU_LEVEL_RGB } from '@/shared'

/**
 * One scorer's A–E bucket filter. Everything scorer-specific comes from its
 * `SCORERS` entry (field, count kind, icon, label, bucket ranges) except the
 * count endpoint: those are generated SDK functions, so they're mapped here —
 * keyed by scorer name, so a new scorer without an endpoint fails to compile.
 */
const props = defineProps<{
  scorer: ScorerUi
}>()

type BucketCounts = { bucket: string, count: number }[] | undefined

const FETCH_COUNTS: Record<ScorerUi['name'], (filter: PostFilterValue) => Promise<BucketCounts>> = {
  waifu: async (filter) => {
    const resp = await v2GetWaifuBucketCount({ body: filter })
    return resp.data
  },
  silva: async (filter) => {
    const resp = await v2GetSilvaBucketCount({ body: filter })
    return resp.data
  },
  silva_luna: async (filter) => {
    const resp = await v2GetSilvaLunaBucketCount({ body: filter })
    return resp.data
  },
}

/** One popover row: a score bucket on the shared A–E quality scale. */
type BucketDef = ReturnType<typeof bucketRows>[number]

// 行序、level、labelKey 全部来自 @/shared 的分档表；数值区间来自打分器表。
const buckets = computed<BucketDef[]>(() => bucketRows({ ...props.scorer.bucketRanges }))
const icon = computed(() => props.scorer.icon)

// Shared A–E ramp (WAIFU_LEVEL_RGB) plus a muted dot for the unscored bucket.
const LEVEL_DOT_RGB: Record<string, string> = {
  ...Object.fromEntries(WAIFU_LEVEL_RGB.map(b => [b.level, b.rgb])),
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

// The scorer is fixed for a mounted instance (FilterRow keys by name), so it
// is read once, like the field/countKind props it replaced.
const { selected: selectedLevels, has: hasLevel, toggle, countQuery, pct, opened } = useFacetFilter<string, { bucket: string, count: number }>({
  field: props.scorer.levelsField,
  countKind: props.scorer.countKind,
  fetchCounts: FETCH_COUNTS[props.scorer.name],
})

const bucketCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = Object.fromEntries(buckets.value.map(b => [b.level, 0]))
  const data = countQuery.data
  if (data.value) {
    for (const d of data.value) {
      out[d.bucket] = d.count
    }
  }
  return out
})

const { t } = useI18n()

/** Button label while nothing is selected. */
const label = computed(() => t(props.scorer.filterLabelKey))

const btnText = computed(() => {
  const item = selectedLevels.value
  return item.length === 0 ? label.value : `${props.scorer.chipPrefix}: ${item.join(', ')}`
})

/** Short spoken name of a level: the letter, or "Unscored". */
function levelName(level: string): string {
  return level === 'UNSCORED' ? t('common.unscored') : level
}

const listbox = useTemplateRef<{ el: HTMLElement | null }>('listbox')
useFacetListbox(() => listbox.value?.el)
const autofocusIndex = computed(() => initialOptionIndex(buckets.value.map(b => b.level), hasLevel))
const triggerLabel = computed(() => facetTriggerLabel(t, label.value, selectedLevels.value.map(levelName)))
function bucketKey(bucket: BucketDef): string {
  return bucket.level
}
function bucketSelected(bucket: BucketDef): boolean {
  return hasLevel(bucket.level)
}
function bucketTypeahead(bucket: BucketDef): string {
  return levelName(bucket.level)
}
function bucketCount(bucket: BucketDef): number | undefined {
  return bucketCounts.value[bucket.level]
}
function toggleBucket(bucket: BucketDef): void {
  toggle(bucket.level)
}
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
        <!-- Typeahead on the letter: "b" jumps to bucket B. -->
        <PFacetList
          ref="listbox"
          :aria-label="label"
          class="p-popover-panel max-w-sm w-max"
          :items="buckets"
          :item-key="bucketKey"
          :selected="bucketSelected"
          :option-label="optionLabel"
          :typeahead="bucketTypeahead"
          :autofocus-index="autofocusIndex"
          :count="bucketCount"
          :share="pct"
          @toggle="toggleBucket"
        >
          <template #default="{ item: bucket }">
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
          </template>
        </PFacetList>
      </template>
    </PPopover>
  </div>
</template>
