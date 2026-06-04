<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetRatingCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'

const { t } = useI18n()

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

const total = computed(() => scoreCountList.value.reduce((a, b) => a + b, 0))

function pct(count: number) {
  return total.value > 0 ? ((count / total.value) * 100).toFixed(1) : '0.0'
}

const btnText = computed(() => {
  const item = ratingFilterData.value
  return item.length === 0 ? t('filter.rating') : item.map(s => getRatingName(s)).join(', ')
})
function getRatingName(rating: number) {
  switch (rating) {
    case 0: {
      return t('rating.unrated')
    }
    case 1: {
      return t('rating.general')
    }
    case 2: {
      return t('rating.sensitive')
    }
    case 3: {
      return t('rating.questionable')
    }
    case 4: {
      return t('rating.explicit')
    }
    default: {
      return t('rating.unknown')
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
              v-if="scoreCountList[rating] || hasRating(rating)"
              class="font-mono inline-flex flex-shrink-0 tabular-nums"
            >
              <span class="text-right flex-shrink-0 w-10" :class="scoreCountList[rating] ? 'text-fg-muted' : 'text-fg-subtle'">{{ scoreCountList[rating] }}</span>
              <span v-if="scoreCountList[rating]" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ pct(scoreCountList[rating]) }}%</span>
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
