<script setup lang="ts">
import { v2GetScoreCount } from '@/api'
import { postFilter } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'

const scoreFilterData = computed({
  get() {
    return postFilter.value.score
  },
  set(val: number[]) {
    postFilter.value.score = val
  },
})
function hasScore(score: number) {
  return scoreFilterData.value.includes(score)
}
function onPointerDown(score: number) {
  if (hasScore(score)) {
    scoreFilterData.value = scoreFilterData.value.filter(s => s !== score)
  }
  else {
    scoreFilterData.value = [...scoreFilterData.value, score]
  }
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
        ...postFilter.value,
      },
    })
    return resp.data
  },
})
const scoreCountList = computed(() => {
  const resp = [0, 0, 0, 0, 0, 0]
  const data = scoreCountMutation.data
  data.value?.forEach((d) => {
    resp[Number(d.score)] = d.count
  })
  return resp
})

const btnText = computed(() => {
  const item = scoreFilterData.value
  if (item.length === 0) {
    return 'Score'
  }
  else {
    return item.map(s => s === 0 ? 'Not Scored Yet' : `${s} Star`).join(', ')
  }
})
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <Btn
        size="sm"
      >
        <i class="i-tabler-star" />
        <span>
          {{ btnText }}
        </span>
      </Btn>
      <template #content>
        <div
          class="min-w-52 border border-surface rounded bg-surface p-1"
        >
          <div
            v-for="score in [5, 4, 3, 2, 1, 0]"
            :key="score"
            class="w-full flex cursor-pointer items-center gap-2 rounded hover:bg-surface-variant-1 px-2 py-1 text-xs"
            @pointerdown="onPointerDown(score)"
          >
            <Checkbox
              class="pointer-events-none flex-shrink-0"
              :model-value="hasScore(score)"
            />
            <div class="h-16px flex flex-grow gap-1">
              <template v-if="score === 0">
                Not Scored Yet
              </template>
              <template v-else>
                <i
                  v-for="i in score"
                  :key="i"
                  class="i-tabler-star-filled"
                />
              </template>
            </div>
            <div
              v-if="scoreCountList[score]"
              class="flex-shrink-0"
            >
              {{ scoreCountList[score] }}
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
