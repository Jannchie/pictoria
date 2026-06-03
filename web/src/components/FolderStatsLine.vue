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

// Colour each score by its own high→low value (green→amber→red), matching the
// detail panel's WaifuScoreLevel ramp. Each metric is normalised by its own max
// (SILVA 0-1, Score 0-5, Rating 0-4). `scored` is a coverage ratio, not a
// score, so it stays neutral grey.
function gradeColor(ratio: number): string {
  if (ratio >= 0.8) {
    return 'var(--p-success-rgb)'
  }
  if (ratio >= 0.6) {
    return '90 190 90'
  }
  if (ratio >= 0.4) {
    return 'var(--p-warning-rgb)'
  }
  if (ratio >= 0.2) {
    return '235 125 45'
  }
  return 'var(--p-danger-rgb)'
}

const metrics = computed<{ key: string, label: string, value: string, color: string | null }[]>(() =>
  [
    { key: 'silva', label: 'SILVA', raw: props.silvaAvg, max: 1, value: props.silvaAvg == null ? '—' : (props.silvaAvg * 10).toFixed(1) },
    { key: 'score', label: 'Score', raw: props.scoreAvg, max: 5, value: props.scoreAvg == null ? '—' : props.scoreAvg.toFixed(1) },
    { key: 'rating', label: 'R', raw: props.ratingAvg, max: 4, value: props.ratingAvg == null ? '—' : props.ratingAvg.toFixed(1) },
    { key: 'scored', label: '', raw: null as number | null, max: 1, value: props.scoredRatio == null ? '—' : `${Math.round(props.scoredRatio * 100)}%` },
  ].map(m => ({
    key: m.key,
    label: m.label,
    value: m.value,
    color: m.raw == null ? null : `rgb(${gradeColor(m.raw / m.max)})`,
  })),
)
</script>

<template>
  <div class="text-[10px] leading-none flex flex-nowrap gap-x-2 items-center overflow-hidden">
    <span
      v-for="m in metrics"
      :key="m.key"
      class="flex gap-0.5 items-center"
    >
      <span v-if="m.label" class="text-fg-subtle">{{ m.label }}</span>
      <span
        class="font-mono tabular-nums"
        :class="m.color ? '' : 'text-fg-muted'"
        :style="m.color ? { color: m.color } : undefined"
      >{{ m.value }}</span>
    </span>
  </div>
</template>
