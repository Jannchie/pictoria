<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetRatingCount } from '@/api'
import { useFacetCounts, useFacetFilter } from '@/composables/useFacetFilter'
import { RATING_ICON, ratingName, ratingVisual } from '@/shared/ratings'
import FacetFilterPopover from './FacetFilterPopover.vue'

const { t } = useI18n()

const { selected: ratingFilterData, has: hasRating, toggle, countQuery, pct, opened } = useFacetFilter<number, { rating: number, count: number }>({
  field: 'rating',
  countKind: 'rating',
  fetchCounts: async (filter) => {
    const resp = await v2GetRatingCount({ body: filter })
    return resp.data
  },
})
const { count: ratingCount, optionCount } = useFacetCounts(countQuery.data, d => Number(d.rating))

// Same order as the popover rows: real levels first, unrated last.
const DISPLAY_ORDER = [1, 2, 3, 4, 0]
const sortedSelection = computed(() =>
  [...ratingFilterData.value].sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b)),
)

function ratingIcon(rating: number) {
  return ratingVisual(rating).icon
}
function ratingIconStyle(rating: number) {
  const { color } = ratingVisual(rating)
  return color ? { color } : undefined
}
function getRatingName(rating: number) {
  return ratingName(rating, t)
}
</script>

<template>
  <FacetFilterPopover
    v-model:opened="opened"
    :label="$t('filter.rating')"
    :items="DISPLAY_ORDER"
    :selection="sortedSelection"
    :has="hasRating"
    :value-name="getRatingName"
    :count="ratingCount"
    :option-count="optionCount"
    :share="pct"
    panel-class="min-w-52"
    @toggle="toggle"
  >
    <template #icon>
      <template v-if="sortedSelection.length > 0">
        <i
          v-for="r in sortedSelection"
          :key="r"
          :class="ratingIcon(r)"
          :style="ratingIconStyle(r)"
          aria-hidden="true"
        />
      </template>
      <i v-else :class="RATING_ICON" aria-hidden="true" />
    </template>
    <template #default="{ item: rating }">
      <div class="flex flex-grow gap-1 items-center">
        <span :class="{ 'text-fg-subtle italic': rating === 0 }">
          {{ getRatingName(rating) }}
        </span>
      </div>
    </template>
  </FacetFilterPopover>
</template>
