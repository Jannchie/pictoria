<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetRatingCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'
import { RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, RATING_LEVEL_LABEL_KEYS, RATING_UNRATED_ICON, RATING_UNRATED_LABEL_KEY } from '@/shared/ratings'

const { t } = useI18n()

const { selected: ratingFilterData, has: hasRating, toggle, countQuery, pct } = useFacetFilter<number, { rating: number, count: number }>({
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

// Same order as the popover rows: real levels first, unrated last.
const DISPLAY_ORDER = [1, 2, 3, 4, 0]
const sortedSelection = computed(() =>
  [...ratingFilterData.value].sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b)),
)

const btnText = computed(() => {
  const item = sortedSelection.value
  return item.length === 0 ? t('filter.rating') : item.map(s => getRatingName(s)).join(', ')
})

function ratingIcon(rating: number) {
  return rating === 0 ? RATING_UNRATED_ICON : RATING_LEVEL_ICONS[rating - 1]
}
function ratingIconStyle(rating: number) {
  return rating === 0 ? undefined : { color: RATING_LEVEL_COLORS[rating - 1] }
}
function getRatingName(rating: number) {
  if (rating === 0) {
    return t(RATING_UNRATED_LABEL_KEY)
  }
  const key = RATING_LEVEL_LABEL_KEYS[rating - 1]
  return key ? t(key) : t('rating.unknown')
}
</script>

<template>
  <div class="relative">
    <Popover position="bottom-start">
      <PButton
        size="sm"
      >
        <template v-if="sortedSelection.length > 0">
          <i
            v-for="r in sortedSelection"
            :key="r"
            :class="ratingIcon(r)"
            :style="ratingIconStyle(r)"
          />
        </template>
        <i v-else class="i-tabler-star" />
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
