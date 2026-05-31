<script setup lang="ts">
interface Props {
  score: number
}

const props = defineProps<Props>()

interface ScoreLevel {
  level: string
  label: string
  rgb: string // raw "r g b" for use inside rgb(...) / rgb(... / a)
  min: number
  max: number
}

// A/B both green, C amber, D orange, E red — a green→warm→danger ramp.
// Same RGB triples used by the dots in WaifuScoreFilter.vue so the chip and
// the filter row read consistently.
const scoreLevels: ScoreLevel[] = [
  { level: 'A', label: 'Best', rgb: 'var(--p-success-rgb)', min: 8, max: 10.001 },
  { level: 'B', label: 'Good', rgb: '90 190 90', min: 6, max: 8 },
  { level: 'C', label: 'Normal', rgb: 'var(--p-warning-rgb)', min: 4, max: 6 },
  { level: 'D', label: 'Bad', rgb: '235 125 45', min: 2, max: 4 },
  { level: 'E', label: 'Worst', rgb: 'var(--p-danger-rgb)', min: 0, max: 2 },
]

const currentLevel = computed(() => {
  return scoreLevels.find(level => props.score >= level.min && props.score < level.max) || scoreLevels[4]
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
    class="text-xs font-mono px-2 py-1 rounded inline-flex gap-1.5 items-baseline"
    :style="levelStyle"
  >
    <span class="font-bold">{{ currentLevel.level }}</span>
    <span class="opacity-80 w-[6ch] inline-block">{{ currentLevel.label }}</span>
    <span class="opacity-40">·</span>
    <span class="opacity-70 tabular-nums">{{ score.toFixed(2) }}</span>
  </span>
</template>
