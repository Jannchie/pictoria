<script setup lang="ts">
import { computed } from 'vue'
import { v2GetWaifuBucketCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'

interface BucketDef {
  level: string // 'S' | 'A' | 'B' | 'C' | 'D' | 'UNSCORED'
  label: string
  range: string // e.g. '8 – 10'
}

// Order matches the popover row order (top → bottom).
const BUCKETS: BucketDef[] = [
  { level: 'A', label: 'Best', range: '8 – 10' },
  { level: 'B', label: 'Good', range: '6 – 8' },
  { level: 'C', label: 'Normal', range: '4 – 6' },
  { level: 'D', label: 'Bad', range: '2 – 4' },
  { level: 'E', label: 'Worst', range: '0 – 2' },
  { level: 'UNSCORED', label: 'Unscored', range: '' },
]

// A/B green, C amber, D orange, E red — a green→warm→danger ramp. The dot
// below uses the same triples as WaifuScoreLevel.vue's chip via CSS vars.
const LEVEL_DOT_RGB: Record<string, string> = {
  A: 'var(--p-success-rgb)', // green
  B: '90 190 90', // green (close to A)
  C: 'var(--p-warning-rgb)', // amber
  D: '235 125 45', // orange
  E: 'var(--p-danger-rgb)', // red
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

const { selected: waifuLevels, has: hasLevel, toggle, countQuery } = useFacetFilter<string, { bucket: string, count: number }>({
  field: 'waifu_score_levels',
  countKind: 'waifu',
  fetchCounts: async (filter) => {
    const resp = await v2GetWaifuBucketCount({ body: filter })
    return resp.data
  },
})

const bucketCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, UNSCORED: 0 }
  const data = countQuery.data
  if (data.value) {
    for (const d of data.value) {
      out[d.bucket] = d.count
    }
  }
  return out
})

const btnText = computed(() => {
  const item = waifuLevels.value
  return item.length === 0 ? 'Waifu Score' : `Waifu: ${item.join(', ')}`
})
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <i class="i-tabler-crown" />
        <span>{{ btnText }}</span>
      </PButton>
      <template #content>
        <div
          class="p-1 border border-border-default rounded bg-surface max-w-sm w-max shadow-lg"
        >
          <div
            v-for="bucket in BUCKETS"
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
                {{ bucket.level === 'UNSCORED' ? 'Unscored' : bucket.level }}
              </span>
              <span
                v-if="bucket.range"
                class="text-fg-muted whitespace-nowrap"
              >
                {{ bucket.label }} ({{ bucket.range }})
              </span>
            </div>
            <div
              v-if="bucketCounts[bucket.level]"
              class="text-fg-muted flex-shrink-0 tabular-nums"
            >
              {{ bucketCounts[bucket.level] }}
            </div>
            <div
              v-else-if="hasLevel(bucket.level)"
              class="text-fg-subtle flex-shrink-0 tabular-nums"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
