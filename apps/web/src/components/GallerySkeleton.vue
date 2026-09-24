<script setup lang="ts">
import { computed } from 'vue'
import { GRID_GAP, GRID_PAD } from '@/shared/gridLayout'

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
  <!-- The shapes are decoration; assistive tech gets one status line instead. -->
  <span class="sr-only" role="status">{{ $t('gallery.loadingPosts') }}</span>
  <div
    class="flex items-start"
    :style="{ padding: `${GRID_PAD}px`, gap: `${GRID_GAP}px` }"
    aria-hidden="true"
  >
    <div
      v-for="(column, ci) in columns"
      :key="ci"
      class="flex flex-col"
      :style="{ gap: `${GRID_GAP}px`, width: itemWidth > 0 ? `${itemWidth}px` : undefined, flex: itemWidth > 0 ? undefined : '1 1 0' }"
    >
      <div
        v-for="(ratio, ri) in column"
        :key="ri"
        class="rounded-md bg-surface-1 w-full animate-pulse"
        :style="{ aspectRatio: String(ratio) }"
      />
    </div>
  </div>
</template>
