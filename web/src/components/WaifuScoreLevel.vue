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

// Continuous green-warm gradient. Same RGB triples used by the dots in
// WaifuScoreFilter.vue so the chip and the filter row read consistently.
const scoreLevels: ScoreLevel[] = [
  { level: 'S', label: 'Excellent', rgb: 'var(--p-success-rgb)', min: 8, max: 10.001 },
  { level: 'A', label: 'Good', rgb: '120 200 80', min: 6, max: 8 },
  { level: 'B', label: 'Average', rgb: '180 180 80', min: 4, max: 6 },
  { level: 'C', label: 'Fair', rgb: '170 130 60', min: 2, max: 4 },
  { level: 'D', label: 'Poor', rgb: '140 110 90', min: 0, max: 2 },
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
  <div class="flex items-center gap-2">
    <div
      class="flex items-center gap-1 rounded px-2 py-1 text-xs font-bold"
      :style="levelStyle"
    >
      <span>{{ currentLevel.level }}</span>
      <span class="text-xs opacity-80">{{ currentLevel.label }}</span>
    </div>
    <span class="text-xs opacity-60">{{ score.toFixed(2) }}</span>
  </div>
</template>
