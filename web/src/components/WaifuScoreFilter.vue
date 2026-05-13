<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2GetWaifuBucketCount } from '@/api'
import { postFilter } from '@/shared'

interface BucketDef {
  level: string // 'S' | 'A' | 'B' | 'C' | 'D' | 'UNSCORED'
  label: string
  range: string // e.g. '8 – 10'
}

// Order matches the popover row order (top → bottom).
const BUCKETS: BucketDef[] = [
  { level: 'S', label: 'Excellent', range: '8 – 10' },
  { level: 'A', label: 'Good', range: '6 – 8' },
  { level: 'B', label: 'Average', range: '4 – 6' },
  { level: 'C', label: 'Fair', range: '2 – 4' },
  { level: 'D', label: 'Poor', range: '0 – 2' },
  { level: 'UNSCORED', label: 'Unscored', range: '' },
]

// Continuous green gradient — picked to read "from very good to so-so" without
// triggering "danger" semantics for low scores. Each entry is one of @roku-ui's
// chip color tokens; the dot below uses the same set via CSS vars.
const LEVEL_DOT_RGB: Record<string, string> = {
  S: 'var(--p-success-rgb)', // saturated green
  A: '120 200 80', // lime
  B: '180 180 80', // olive
  C: '170 130 60', // muted ochre
  D: '140 110 90', // dusty brown
  UNSCORED: 'var(--p-fg-muted-rgb)',
}

const waifuLevels = computed({
  get() {
    return postFilter.value.waifu_score_levels
  },
  set(value: string[]) {
    postFilter.value.waifu_score_levels = value
  },
})

function hasLevel(level: string) {
  return waifuLevels.value.includes(level)
}

function onPointerDown(level: string) {
  waifuLevels.value = hasLevel(level)
    ? waifuLevels.value.filter(l => l !== level)
    : [...waifuLevels.value, level]
}

const filterWithoutWaifu = computed(() => {
  return {
    ...postFilter.value,
    waifu_score_levels: [],
  }
})

const bucketCountQuery = useQuery({
  queryKey: ['count', 'waifu', filterWithoutWaifu],
  queryFn: async () => {
    const resp = await v2GetWaifuBucketCount({
      body: filterWithoutWaifu.value,
    })
    return resp.data
  },
})

const bucketCounts = computed<Record<string, number>>(() => {
  const out: Record<string, number> = { S: 0, A: 0, B: 0, C: 0, D: 0, UNSCORED: 0 }
  const data = bucketCountQuery.data
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
          class="min-w-56 border border-border-default rounded bg-surface p-1 shadow-lg"
        >
          <div
            v-for="bucket in BUCKETS"
            :key="bucket.level"
            class="w-full flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-2"
            @pointerdown="onPointerDown(bucket.level)"
          >
            <Checkbox
              class="pointer-events-none flex-shrink-0"
              :model-value="hasLevel(bucket.level)"
            />
            <div class="flex flex-grow items-center gap-2">
              <span
                class="h-3 w-3 flex-shrink-0 rounded-full"
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
                class="text-fg-muted"
              >
                {{ bucket.label }} ({{ bucket.range }})
              </span>
            </div>
            <div
              v-if="bucketCounts[bucket.level]"
              class="flex-shrink-0 text-fg-muted tabular-nums"
            >
              {{ bucketCounts[bucket.level] }}
            </div>
            <div
              v-else-if="hasLevel(bucket.level)"
              class="flex-shrink-0 text-fg-subtle tabular-nums"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
