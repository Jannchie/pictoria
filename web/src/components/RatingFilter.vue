<script setup lang="ts">
import { computed } from 'vue'
import { v2GetRatingCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'

const { selected: ratingFilterData, has: hasRating, toggle, countQuery } = useFacetFilter<number, { rating: number, count: number }>({
  field: 'rating',
  countKind: 'rating',
  fetchCounts: async (filter) => {
    const resp = await v2GetRatingCount({ body: filter })
    return resp.data
  },
})

const scoreCountList = computed(() => {
  const resp = [0, 0, 0, 0, 0]
  const data = countQuery.data
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
          class="p-1 border border-border-default rounded bg-surface min-w-52 shadow-lg"
        >
          <div
            v-for="rating in [1, 2, 3, 4, 0]"
            :key="rating"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
            @pointerdown="toggle(rating)"
          >
            <Checkbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasRating(rating)"
            />
            <div class="flex flex-grow gap-1 items-center">
              <span :class="{ 'text-fg-subtle italic': rating === 0 }">
                {{ getRatingName(rating) }}
              </span>
            </div>
            <div
              v-if="scoreCountList[rating]"
              class="text-fg-muted flex-shrink-0 tabular-nums"
            >
              {{ scoreCountList[rating] }}
            </div>
            <div
              v-else-if="hasRating(rating)"
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
