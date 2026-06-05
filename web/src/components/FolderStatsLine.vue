<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { waifuLevelRgb } from '@/shared'

// Per-directory aggregate stats, shown as the second line of a folder tree row.
// SILVA is stored raw 0~1; ×10 here to match how the score is shown elsewhere.
const props = defineProps<{
  silvaAvg?: number | null
  scoreAvg?: number | null
  ratingAvg?: number | null
  scoredRatio?: number | null
  postCount?: number
}>()

const { t } = useI18n()

// Colour each score by its own high→low value (green→amber→red) via the shared
// WAIFU_LEVEL_RGB ramp (ratio ×10 = waifu scale). Each metric is normalised by
// its own max (SILVA 0-1, Score 0-5, Rating 0-4). `scored` is a coverage
// ratio, not a score, so it stays neutral grey.
function gradeColor(ratio: number): string {
  return waifuLevelRgb(ratio * 10)
}

const metrics = computed<{ key: string, label: string, value: string, color: string | null }[]>(() =>
  [
    { key: 'silva', label: 'SILVA', raw: props.silvaAvg, max: 1, value: props.silvaAvg == null ? '—' : (props.silvaAvg * 10).toFixed(1) },
    { key: 'score', label: t('filter.score'), raw: props.scoreAvg, max: 5, value: props.scoreAvg == null ? '—' : props.scoreAvg.toFixed(1) },
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
