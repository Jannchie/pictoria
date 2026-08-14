<script setup lang="ts">
import { computed } from 'vue'

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
    class="px-2 py-2 flex gap-6 items-start"
    aria-hidden="true"
  >
    <div
      v-for="(column, ci) in columns"
      :key="ci"
      class="flex flex-col gap-9"
      :style="{ width: itemWidth > 0 ? `${itemWidth}px` : undefined, flex: itemWidth > 0 ? undefined : '1 1 0' }"
    >
      <div
        v-for="(ratio, ri) in column"
        :key="ri"
        class="flex flex-col gap-1"
      >
        <div
          class="rounded-lg bg-surface-1 w-full animate-pulse"
          :style="{ aspectRatio: String(ratio) }"
        />
        <div class="rounded bg-surface-1 h-3 w-3/4 self-center animate-pulse" />
      </div>
    </div>
  </div>
</template>
