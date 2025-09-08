<script setup lang="ts">
interface Props {
  score: number
}

const props = defineProps<Props>()

interface ScoreLevel {
  level: string
  label: string
  color: string
  bgColor: string
  min: number
  max: number
}

const scoreLevels: ScoreLevel[] = [
  { level: 'S', label: 'Excellent', color: 'text-red-400', bgColor: 'bg-red-500/20', min: 8, max: 10 },
  { level: 'A', label: 'Good', color: 'text-orange-400', bgColor: 'bg-orange-500/20', min: 6, max: 8 },
  { level: 'B', label: 'Average', color: 'text-purple-400', bgColor: 'bg-purple-500/20', min: 4, max: 6 },
  { level: 'C', label: 'Fair', color: 'text-white', bgColor: 'bg-white/20', min: 2, max: 4 },
  { level: 'D', label: 'Poor', color: 'text-gray-400', bgColor: 'bg-gray-500/20', min: 0, max: 2 },
]

const currentLevel = computed(() => {
  return scoreLevels.find(level => props.score >= level.min && props.score < level.max) || scoreLevels[4]
})
</script>

<template>
  <div class="flex gap-2 items-center">
    <div
      class="text-xs font-bold px-2 py-1 rounded flex gap-1 items-center"
      :class="[currentLevel.color, currentLevel.bgColor]"
    >
      <span>{{ currentLevel.level }}</span>
      <span class="text-xs opacity-80">{{ currentLevel.label }}</span>
    </div>
    <span class="text-xs opacity-60">{{ score.toFixed(2) }}</span>
  </div>
</template>
