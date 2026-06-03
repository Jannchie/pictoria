<script setup lang="ts">
import { computed } from 'vue'

// Per-directory aggregate stats, shown as the second line of a folder tree row.
// SILVA is stored raw 0~1; ×10 here to match how the score is shown elsewhere.
const props = defineProps<{
  silvaAvg?: number | null
  scoreAvg?: number | null
  ratingAvg?: number | null
  scoredRatio?: number | null
  postCount?: number
}>()

const metrics = computed(() => [
  { key: 'silva', label: 'SILVA', value: props.silvaAvg == null ? '—' : (props.silvaAvg * 10).toFixed(1) },
  { key: 'score', label: 'Score', value: props.scoreAvg == null ? '—' : props.scoreAvg.toFixed(1) },
  { key: 'rating', label: 'R', value: props.ratingAvg == null ? '—' : props.ratingAvg.toFixed(1) },
  { key: 'scored', label: '', value: props.scoredRatio == null ? '—' : `${Math.round(props.scoredRatio * 100)}%` },
])
</script>

<template>
  <div class="text-[10px] leading-none flex flex-wrap gap-x-2 gap-y-0.5 items-center">
    <span
      v-for="m in metrics"
      :key="m.key"
      class="flex gap-0.5 items-center"
    >
      <span v-if="m.label" class="text-fg-subtle">{{ m.label }}</span>
      <span class="text-fg-muted font-mono tabular-nums">{{ m.value }}</span>
    </span>
  </div>
</template>
