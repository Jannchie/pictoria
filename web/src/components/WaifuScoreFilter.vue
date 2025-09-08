<script setup lang="ts">
import { Btn } from '@roku-ui/vue'
import { computed, ref, watchEffect } from 'vue'
import { postFilter } from '@/shared'

const minScore = ref(0)
const maxScore = ref(10)

const waifuScoreRange = computed({
  get() {
    return postFilter.value.waifu_score_range || [0, 10]
  },
  set(value: [number, number]) {
    // Only set filter if range is not [0, 10] (the full range)
    postFilter.value.waifu_score_range = value[0] === 0 && value[1] === 10 ? undefined : value
  },
})

// Sync local refs with computed value
watchEffect(() => {
  const range = waifuScoreRange.value
  minScore.value = range[0]
  maxScore.value = range[1]
})

const btnText = computed(() => {
  const range = waifuScoreRange.value
  if (range[0] === 0 && range[1] === 10) {
    return 'Waifu Score'
  }
  return `Waifu: ${range[0].toFixed(1)}-${range[1].toFixed(1)}`
})

const isActive = computed(() => {
  const range = waifuScoreRange.value
  return !(range[0] === 0 && range[1] === 10)
})

function applyRange() {
  // Ensure min <= max
  const min = Math.min(minScore.value, maxScore.value)
  const max = Math.max(minScore.value, maxScore.value)
  waifuScoreRange.value = [min, max]
}

function resetFilter() {
  minScore.value = 0
  maxScore.value = 10
  waifuScoreRange.value = [0, 10]
}

// Quick preset buttons for different levels
function selectLevel(level: 'S' | 'A' | 'B' | 'C' | 'D') {
  switch (level) {
    case 'S': {
      minScore.value = 8
      maxScore.value = 10
      break
    }
    case 'A': {
      minScore.value = 6
      maxScore.value = 8
      break
    }
    case 'B': {
      minScore.value = 4
      maxScore.value = 6
      break
    }
    case 'C': {
      minScore.value = 2
      maxScore.value = 4
      break
    }
    case 'D': {
      minScore.value = 0
      maxScore.value = 2
      break
    }
  }
  applyRange()
}
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <Btn
        size="sm"
        :variant="isActive ? 'default' : undefined"
      >
        <i class="i-tabler-crown" />
        <span>
          {{ btnText }}
        </span>
      </Btn>
      <template #content>
        <div class="p-4 border border-surface rounded bg-surface min-w-80 space-y-4">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Waifu Score Range</span>
            <Btn
              v-if="isActive"
              size="sm"
              @click="resetFilter"
            >
              Reset
            </Btn>
          </div>

          <!-- Quick Level Selection -->
          <div class="space-y-3">
            <div class="text-xs text-zinc-400">
              Quick Select:
            </div>
            <div class="flex gap-2 justify-center">
              <Btn
                size="sm"
                class="text-red-400 hover:bg-red-500/20"
                @click="selectLevel('S')"
              >
                S (8-10)
              </Btn>
              <Btn
                size="sm"
                class="text-orange-400 hover:bg-orange-500/20"
                @click="selectLevel('A')"
              >
                A (6-8)
              </Btn>
              <Btn
                size="sm"
                class="text-purple-400 hover:bg-purple-500/20"
                @click="selectLevel('B')"
              >
                B (4-6)
              </Btn>
              <Btn
                size="sm"
                class="text-white hover:bg-white/20"
                @click="selectLevel('C')"
              >
                C (2-4)
              </Btn>
              <Btn
                size="sm"
                class="text-gray-400 hover:bg-gray-500/20"
                @click="selectLevel('D')"
              >
                D (0-2)
              </Btn>
            </div>
          </div>

          <!-- Custom Range -->
          <div class="space-y-3">
            <div class="text-xs text-zinc-400">
              Custom Range:
            </div>
            <div class="flex gap-2 items-center">
              <input
                v-model.number="minScore"
                type="number"
                min="0"
                max="10"
                step="0.1"
                class="text-xs text-white px-2 py-1 border border-surface-3 rounded bg-surface-1 w-20"
                @blur="applyRange"
              >
              <span class="text-xs text-zinc-400">to</span>
              <input
                v-model.number="maxScore"
                type="number"
                min="0"
                max="10"
                step="0.1"
                class="text-xs text-white px-2 py-1 border border-surface-3 rounded bg-surface-1 w-20"
                @blur="applyRange"
              >
              <Btn
                size="sm"
                @click="applyRange"
              >
                Apply
              </Btn>
            </div>
          </div>

          <!-- Current Range Display -->
          <div class="text-xs text-zinc-400 text-center">
            Current: {{ waifuScoreRange[0].toFixed(1) }} - {{ waifuScoreRange[1].toFixed(1) }}
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
