<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetScoreCount } from '@/api'
import { facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'

const { t } = useI18n()

const { selected: scoreFilterData, has: hasScore, toggle, countQuery, pct, opened } = useFacetFilter<number, { score: number, count: number }>({
  field: 'score',
  countKind: 'score',
  fetchCounts: async (filter) => {
    const resp = await v2GetScoreCount({ body: filter })
    return resp.data
  },
})
const scoreCountList = computed(() => {
  const resp = [0, 0, 0, 0, 0, 0]
  const data = countQuery.data
  if (data.value) {
    for (const d of data.value) {
      resp[Number(d.score)] = d.count
    }
  }
  return resp
})

// Popover rows, best first; 0 = not scored yet.
const DISPLAY_ORDER = [5, 4, 3, 2, 1, 0]

function scoreCount(score: number): number | undefined {
  return scoreCountList.value[score]
}

function scoreName(score: number): string {
  return score === 0 ? t('filter.notScoredYet') : t('filter.star', { n: score }, score)
}

const btnText = computed(() => {
  const item = scoreFilterData.value
  return item.length === 0 ? t('filter.score') : item.map(scoreName).join(', ')
})

const listbox = useTemplateRef<{ el: HTMLElement | null }>('listbox')
useFacetListbox(() => listbox.value?.el)
const autofocusIndex = computed(() => initialOptionIndex(DISPLAY_ORDER, hasScore))
const triggerLabel = computed(() => facetTriggerLabel(t, t('filter.score'), scoreFilterData.value.map(scoreName)))
function optionLabel(score: number) {
  return facetOptionLabel(t, scoreName(score), countQuery.data.value ? scoreCountList.value[score] : undefined)
}
</script>

<template>
  <div class="relative">
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="scoreFilterData.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <i class="i-tabler-star" aria-hidden="true" />
        <span>
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <!-- Typeahead on the digit: "3" jumps to three stars, "0" to unscored. -->
        <PFacetList
          ref="listbox"
          :aria-label="$t('filter.score')"
          class="p-popover-panel min-w-52"
          :items="DISPLAY_ORDER"
          :selected="hasScore"
          :option-label="optionLabel"
          :typeahead="String"
          :autofocus-index="autofocusIndex"
          :count="scoreCount"
          :share="pct"
          @toggle="toggle"
        >
          <template #default="{ item: score }">
            <div class="flex flex-grow gap-1 items-center">
              <template v-if="score === 0">
                <span class="text-fg-subtle italic">{{ $t('common.unscored') }}</span>
              </template>
              <template v-else>
                <i
                  v-for="n in score"
                  :key="n"
                  class="i-tabler-star-filled text-warning"
                  aria-hidden="true"
                />
              </template>
            </div>
          </template>
        </PFacetList>
      </template>
    </PPopover>
  </div>
</template>
