<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2GetRatingCount } from '@/api'
import { postFilter } from '@/shared'

const ratingFilterData = computed({
  get() {
    return postFilter.value.rating
  },
  set(value: number[]) {
    postFilter.value.rating = value
  },
})
function hasRating(rating: number) {
  return ratingFilterData.value.includes(rating)
}
function onPointerDown(rating: number) {
  ratingFilterData.value = hasRating(rating) ? ratingFilterData.value.filter(s => s !== rating) : [...ratingFilterData.value, rating]
}
const filterWithoutRating = computed(() => {
  return {
    ...postFilter.value,
    rating: [],
  }
})

const scoreCountMutation = useQuery({
  queryKey: ['count', 'rating', filterWithoutRating],
  queryFn: async () => {
    const resp = await v2GetRatingCount({
      body: {
        ...filterWithoutRating.value, // 使用不包含自己筛选条件的过滤器
      },
    })
    return resp.data
  },
})

const scoreCountList = computed(() => {
  const resp = [0, 0, 0, 0, 0]
  const data = scoreCountMutation.data
  if (data.value) {
    for (const d of data.value) {
      resp[Number(d.rating)] = d.count
    }
  }
  return resp
})

const btnText = computed(() => {
  const item = ratingFilterData.value
  return item.length === 0 ? 'Rating' : item.map(s => getRatingName(s)).join(', ')
})
function getRatingName(rating: number) {
  switch (rating) {
    case 0: {
      return 'Unrated'
    }
    case 1: {
      return 'General'
    }
    case 2: {
      return 'Sensitive'
    }
    case 3: {
      return 'Questionable'
    }
    case 4: {
      return 'Explicit'
    }
    default: {
      return 'Unknown'
    }
  }
}
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
          class="min-w-52 border border-border-default rounded bg-surface p-1 shadow-lg"
        >
          <div
            v-for="rating in [1, 2, 3, 4, 0]"
            :key="rating"
            class="w-full flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-2"
            @pointerdown="onPointerDown(rating)"
          >
            <Checkbox
              class="pointer-events-none flex-shrink-0"
              :model-value="hasRating(rating)"
            />
            <div class="flex flex-grow items-center gap-1">
              <span :class="{ 'text-fg-subtle italic': rating === 0 }">
                {{ getRatingName(rating) }}
              </span>
            </div>
            <div
              v-if="scoreCountList[rating]"
              class="flex-shrink-0 text-fg-muted tabular-nums"
            >
              {{ scoreCountList[rating] }}
            </div>
            <div
              v-else-if="hasRating(rating)"
              class="flex-shrink-0 text-fg-subtle tabular-nums"
            >
              0
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
