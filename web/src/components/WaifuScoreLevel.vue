<script setup lang="ts">
import { waifuLevel } from '@/shared'

interface Props {
  score: number
}

const props = defineProps<Props>()

// Colour ramp shared via WAIFU_LEVEL_RGB (also the filter dots and the
// gallery sort badge); only the bucket label keys are local to this chip.
const LABEL_KEYS: Record<string, string> = {
  A: 'filter.bucketBest',
  B: 'filter.bucketGood',
  C: 'filter.bucketNormal',
  D: 'filter.bucketBad',
  E: 'filter.bucketWorst',
}

const currentLevel = computed(() => {
  const bucket = waifuLevel(props.score)
  return { ...bucket, labelKey: LABEL_KEYS[bucket.level] }
})

const levelStyle = computed(() => {
  const rgb = currentLevel.value.rgb
  return {
    '--l-bg': `rgb(${rgb} / 0.2)`,
    '--l-text': `rgb(${rgb})`,
    '--l-border': `rgb(${rgb} / 0.3)`,
    'backgroundColor': 'var(--l-bg)',
    'color': 'var(--l-text)',
    'border': '1px solid var(--l-border)',
  }
})
</script>

<template>
  <span
    class="text-xs font-mono px-1.5 py-0.5 rounded inline-flex gap-1 items-baseline"
    :style="levelStyle"
  >
    <span class="font-bold">{{ currentLevel.level }}</span>
    <span class="opacity-80 w-[6ch] inline-block">{{ $t(currentLevel.labelKey) }}</span>
    <span class="opacity-40">·</span>
    <span class="opacity-70 tabular-nums">{{ score.toFixed(2) }}</span>
  </span>
</template>
