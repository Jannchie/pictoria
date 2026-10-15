<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetRatingCount } from '@/api'
import { facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'
import { RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, RATING_LEVEL_LABEL_KEYS, RATING_UNRATED_ICON, RATING_UNRATED_LABEL_KEY } from '@/shared/ratings'

const { t } = useI18n()

const { selected: ratingFilterData, has: hasRating, toggle, countQuery, pct, opened } = useFacetFilter<number, { rating: number, count: number }>({
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

const listbox = useTemplateRef<{ el: HTMLElement | null }>('listbox')
useFacetListbox(() => listbox.value?.el)
const autofocusIndex = computed(() => initialOptionIndex(DISPLAY_ORDER, hasRating))
const triggerLabel = computed(() => facetTriggerLabel(t, t('filter.rating'), sortedSelection.value.map(getRatingName)))
function optionLabel(rating: number) {
  return facetOptionLabel(t, getRatingName(rating), countQuery.data.value ? scoreCountList.value[rating] : undefined)
}

function ratingCount(rating: number): number | undefined {
  return scoreCountList.value[rating]
}

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
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="sortedSelection.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <template v-if="sortedSelection.length > 0">
          <i
            v-for="r in sortedSelection"
            :key="r"
            :class="ratingIcon(r)"
            :style="ratingIconStyle(r)"
            aria-hidden="true"
          />
        </template>
        <i v-else class="i-tabler-star" aria-hidden="true" />
        <span>
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <PFacetList
          ref="listbox"
          :aria-label="$t('filter.rating')"
          class="p-popover-panel min-w-52"
          :items="DISPLAY_ORDER"
          :selected="hasRating"
          :option-label="optionLabel"
          :typeahead="getRatingName"
          :autofocus-index="autofocusIndex"
          :count="ratingCount"
          :share="pct"
          @toggle="toggle"
        >
          <template #default="{ item: rating }">
            <div class="flex flex-grow gap-1 items-center">
              <span :class="{ 'text-fg-subtle italic': rating === 0 }">
                {{ getRatingName(rating) }}
              </span>
            </div>
          </template>
        </PFacetList>
      </template>
    </PPopover>
  </div>
</template>
