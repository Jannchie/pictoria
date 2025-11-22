<script setup lang="ts">
interface Props {
  score: number
}

const props = defineProps<Props>()

interface ScoreLevel {
  level: string
  label: string
  scheme: 'primary' | 'secondary' | 'tertiary' | 'success' | 'info' | 'warning' | 'error'
  min: number
  max: number
}

const scoreLevels: ScoreLevel[] = [
  { level: 'S', label: 'Excellent', scheme: 'success', min: 8, max: 10 },
  { level: 'A', label: 'Good', scheme: 'primary', min: 6, max: 8 },
  { level: 'B', label: 'Average', scheme: 'secondary', min: 4, max: 6 },
  { level: 'C', label: 'Fair', scheme: 'info', min: 2, max: 4 },
  { level: 'D', label: 'Poor', scheme: 'warning', min: 0, max: 2 },
]

const currentLevel = computed(() => {
  return scoreLevels.find(level => props.score >= level.min && props.score < level.max) || scoreLevels[4]
})

const levelStyle = computed(() => {
  const scheme = currentLevel.value.scheme
  return {
    '--l-bg': `rgb(var(--r-bg-${scheme}) / 0.2)`,
    '--l-text': `rgb(var(--r-text-${scheme}))`,
    '--l-border': `rgb(var(--r-bg-${scheme}) / 0.3)`,
  }
})
</script>

<template>
  <div class="flex gap-2 items-center">
    <div
      class="text-xs custom-colors font-bold px-2 py-1 rounded flex gap-1 items-center"
      :style="levelStyle"
    >
      <span>{{ currentLevel.level }}</span>
      <span class="text-xs opacity-80">{{ currentLevel.label }}</span>
    </div>
    <span class="text-xs opacity-60">{{ score.toFixed(2) }}</span>
  </div>
</template>
