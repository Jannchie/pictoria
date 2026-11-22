<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import type { ScorerUi } from '@/shared/scorers'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetSilvaBucketCount } from '@/api'
import { useFacetCounts, useFacetFilter } from '@/composables/useFacetFilter'
import { bucketRows, MODEL_LEVEL_RGB } from '@/shared'
import FacetFilterPopover from './FacetFilterPopover.vue'

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
  silva: async (filter) => {
    const resp = await v2GetSilvaBucketCount({ body: filter })
    return resp.data
  },
}

/** One popover row: a score bucket on the shared A–E quality scale. */
type BucketDef = ReturnType<typeof bucketRows>[number]

// 行序、level、labelKey 全部来自 @/shared 的分档表；数值区间来自打分器表。
const buckets = computed<BucketDef[]>(() => bucketRows({ ...props.scorer.bucketRanges }))
const icon = computed(() => props.scorer.icon)

// Shared A–E ramp (MODEL_LEVEL_RGB) plus a muted dot for the unscored bucket.
const LEVEL_DOT_RGB: Record<string, string> = {
  ...Object.fromEntries(MODEL_LEVEL_RGB.map(b => [b.level, b.rgb])),
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

// The scorer is fixed for a mounted instance (FilterRow keys by name), so it
// is read once, like the field/countKind props it replaced.
const { selected: selectedLevels, has: hasLevel, toggle, countQuery, pct, opened } = useFacetFilter<string, { bucket: string, count: number }>({
  field: props.scorer.levelsField,
  countKind: props.scorer.countKind,
  fetchCounts: FETCH_COUNTS[props.scorer.name],
})
const { count: bucketCount, optionCount } = useFacetCounts(countQuery.data, d => d.bucket)

const { t } = useI18n()

/** Button label while nothing is selected. */
const label = computed(() => t(props.scorer.filterLabelKey))

/**
 * Short spoken name of a level: the letter, or "Unscored". Also the typeahead
 * text ("b" jumps to bucket B). The trigger text shows the bare levels after
 * the scorer's chip prefix instead (`String`).
 */
function levelName(level: string): string {
  return level === 'UNSCORED' ? t('common.unscored') : level
}

function bucketLevel(bucket: BucketDef): string {
  return bucket.level
}
function bucketOptionName(bucket: BucketDef): string {
  return bucket.range
    ? t('filter.bucketOption', { level: bucket.level, name: t(bucket.labelKey), range: bucket.range })
    : levelName(bucket.level)
}
</script>

<template>
  <FacetFilterPopover
    v-model:opened="opened"
    :label="label"
    :items="buckets"
    :item-key="bucketLevel"
    :item-value="bucketLevel"
    :selection="selectedLevels"
    :has="hasLevel"
    :value-name="levelName"
    :value-text="String"
    :chip-prefix="scorer.chipPrefix"
    :option-name="bucketOptionName"
    :count="bucketCount"
    :option-count="optionCount"
    :share="pct"
    :icon="icon"
    panel-class="max-w-sm w-max"
    @toggle="toggle"
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
  </FacetFilterPopover>
</template>
