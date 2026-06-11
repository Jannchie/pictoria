<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { computed } from 'vue'
import { useFacetFilter } from '@/composables/useFacetFilter'
import { WAIFU_LEVEL_RGB } from '@/shared'

/** One popover row: a score bucket on the shared A–E quality scale. */
interface BucketDef {
  level: string // 'A' | 'B' | 'C' | 'D' | 'E' | 'UNSCORED'
  labelKey: string
  range: string // e.g. '0.8 – 1.0'
}

const props = defineProps<{
  /** The `postFilter` array facet this filter drives. */
  field: 'waifu_score_levels' | 'silva_score_levels'
  countKind: 'waifu' | 'silva'
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

const { selected: selectedLevels, has: hasLevel, toggle, countQuery, pct } = useFacetFilter<string, { bucket: string, count: number }>({
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
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <i :class="icon" />
        <span>{{ btnText }}</span>
      </PButton>
      <template #content>
        <div
          class="p-1 border border-border-default rounded bg-surface max-w-sm w-max shadow-lg"
        >
          <div
            v-for="bucket in buckets"
            :key="bucket.level"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
            @pointerdown="toggle(bucket.level)"
          >
            <Checkbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasLevel(bucket.level)"
            />
            <div class="flex flex-grow gap-2 items-center">
              <span
                class="rounded-full flex-shrink-0 h-3 w-3"
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
    </Popover>
  </div>
</template>
