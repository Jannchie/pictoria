<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2GetScoreCount } from '@/api'
import { postFilter } from '@/shared'

const scoreFilterData = computed({
  get() {
    return postFilter.value.score
  },
  set(value: number[]) {
    postFilter.value.score = value
  },
})
function hasScore(score: number) {
  return scoreFilterData.value.includes(score)
}
function onPointerDown(score: number) {
  scoreFilterData.value = hasScore(score) ? scoreFilterData.value.filter(s => s !== score) : [...scoreFilterData.value, score]
}
const filterWidthoutScore = computed(() => {
  return {
    ...postFilter.value,
    score: [],
  }
})
const scoreCountMutation = useQuery({
  queryKey: ['count', 'score', filterWidthoutScore],
  queryFn: async () => {
    const resp = await v2GetScoreCount({
      body: {
        ...filterWidthoutScore.value, // 使用不包含自己筛选条件的过滤器
      },
    })
    return resp.data
  },
})
const scoreCountList = computed(() => {
  const resp = [0, 0, 0, 0, 0, 0]
  const data = scoreCountMutation.data
  if (data.value) {
    for (const d of data.value) {
      resp[Number(d.score)] = d.count
    }
  }
  return resp
})

const btnText = computed(() => {
  const item = scoreFilterData.value
  return item.length === 0 ? 'Score' : item.map(s => s === 0 ? 'Not Scored Yet' : `${s} Star`).join(', ')
})
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <i class="i-tabler-star" />
        <span>
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div
          class="p-1 border border-border-default rounded bg-surface min-w-52 shadow-lg"
        >
          <div
            v-for="score in [5, 4, 3, 2, 1, 0]"
            :key="score"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
            @pointerdown="onPointerDown(score)"
          >
            <Checkbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasScore(score)"
            />
            <div class="flex flex-grow gap-1 items-center">
              <template v-if="score === 0">
                <span class="text-fg-subtle italic">Unscored</span>
              </template>
              <template v-else>
                <i
                  v-for="i in score"
                  :key="i"
                  class="i-tabler-star-filled text-warning"
                />
              </template>
            </div>
            <div
              v-if="scoreCountList[score]"
              class="text-fg-muted flex-shrink-0 tabular-nums"
            >
              {{ scoreCountList[score] }}
            </div>
            <div
              v-else-if="hasScore(score)"
              class="text-fg-subtle flex-shrink-0 tabular-nums"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
