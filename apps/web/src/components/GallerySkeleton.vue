<script setup lang="ts">
import { computed } from 'vue'
import { GRID_GAP, GRID_PAD, GRID_Y_GAP } from '@/shared/gridLayout'

// Placeholder grid shown while the first page of posts is in flight. It mirrors
// the Waterfall's column geometry (same itemWidth / cols / gap) so the real
// grid lands on the same rhythm instead of jumping when data arrives.
const props = withDefaults(
  defineProps<{
    cols: number
    itemWidth: number
    /** How many placeholders to draw — roughly 3 screens' worth. */
    count?: number
  }>(),
  { count: 24 },
)

// Fixed aspect-ratio cycle rather than Math.random(): a stable sequence keeps
// the skeleton from reshuffling on every re-render (and keeps it testable).
const RATIOS = [1.5, 0.75, 1, 1.33, 0.66, 1.2, 0.8, 1.77, 1, 0.7, 1.4, 0.9]

const columns = computed(() => {
  const n = Math.max(1, props.cols)
  const buckets: number[][] = Array.from({ length: n }, () => [])
  // Column-major fill so each column gets a different height mix, the way a
  // real masonry layout looks — round-robin, not sequential chunks.
  for (let i = 0; i < props.count; i++) {
    buckets[i % n].push(RATIOS[i % RATIOS.length])
  }
  return buckets
})
</script>

<template>
  <div
    class="flex items-start"
    :style="{ padding: `${GRID_PAD}px`, gap: `${GRID_GAP}px` }"
    aria-hidden="true"
  >
    <div
      v-for="(column, ci) in columns"
      :key="ci"
      class="flex flex-col"
      :style="{ gap: `${GRID_Y_GAP}px`, width: itemWidth > 0 ? `${itemWidth}px` : undefined, flex: itemWidth > 0 ? undefined : '1 1 0' }"
    >
      <div
        v-for="(ratio, ri) in column"
        :key="ri"
        class="flex flex-col gap-1.5"
      >
        <div
          class="rounded-md bg-surface-1 w-full animate-pulse"
          :style="{ aspectRatio: String(ratio) }"
        />
        <!-- One caption line, left-aligned, like PostItem's filename. -->
        <div class="rounded-xs bg-surface-1 h-3 w-2/3 animate-pulse" />
      </div>
    </div>
  </div>
</template>
