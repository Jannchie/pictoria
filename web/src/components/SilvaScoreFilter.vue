<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetSilvaBucketCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'
import { WAIFU_LEVEL_RGB } from '@/shared'

const { t } = useI18n()

interface BucketDef {
  level: string // 'A' | 'B' | 'C' | 'D' | 'E' | 'UNSCORED'
  labelKey: string
  range: string // e.g. '0.8 – 1.0'
}

// Order matches the popover row order (top → bottom).
const BUCKETS: BucketDef[] = [
  { level: 'A', labelKey: 'filter.bucketBest', range: '0.8 – 1.0' },
  { level: 'B', labelKey: 'filter.bucketGood', range: '0.6 – 0.8' },
  { level: 'C', labelKey: 'filter.bucketNormal', range: '0.4 – 0.6' },
  { level: 'D', labelKey: 'filter.bucketBad', range: '0.2 – 0.4' },
  { level: 'E', labelKey: 'filter.bucketWorst', range: '0 – 0.2' },
  { level: 'UNSCORED', labelKey: 'common.unscored', range: '' },
]

// Shared A–E ramp (WAIFU_LEVEL_RGB) plus a muted dot for the unscored bucket.
const LEVEL_DOT_RGB: Record<string, string> = {
  ...Object.fromEntries(WAIFU_LEVEL_RGB.map(b => [b.level, b.rgb])),
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

const { selected: silvaLevels, has: hasLevel, toggle, countQuery } = useFacetFilter<string, { bucket: string, count: number }>({
  field: 'silva_score_levels',
  countKind: 'silva',
  fetchCounts: async (filter) => {
    const resp = await v2GetSilvaBucketCount({ body: filter })
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

const total = computed(() => Object.values(bucketCounts.value).reduce((a, b) => a + b, 0))

function pct(count: number) {
  return total.value > 0 ? ((count / total.value) * 100).toFixed(1) : '0.0'
}

const btnText = computed(() => {
  const item = silvaLevels.value
  return item.length === 0 ? t('filter.silvaScore') : `SILVA: ${item.join(', ')}`
})
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <i class="i-tabler-rosette" />
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
