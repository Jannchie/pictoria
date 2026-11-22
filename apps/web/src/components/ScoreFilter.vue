<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { v2GetScoreCount } from '@/api'
import { useFacetCounts, useFacetFilter } from '@/composables/useFacetFilter'
import FacetFilterPopover from './FacetFilterPopover.vue'

const { t } = useI18n()

const { selected: scoreFilterData, has: hasScore, toggle, countQuery, pct, opened } = useFacetFilter<number, { score: number, count: number }>({
  field: 'score',
  countKind: 'score',
  fetchCounts: async (filter) => {
    const resp = await v2GetScoreCount({ body: filter })
    return resp.data
  },
})
const { count: scoreCount, optionCount } = useFacetCounts(countQuery.data, d => Number(d.score))

// Popover rows, best first; 0 = not scored yet. Typeahead is on the digit
// (`String`): "3" jumps to three stars, "0" to unscored.
const DISPLAY_ORDER = [5, 4, 3, 2, 1, 0]

function scoreName(score: number): string {
  return score === 0 ? t('filter.notScoredYet') : t('filter.star', { n: score }, score)
}
</script>

<template>
  <FacetFilterPopover
    v-model:opened="opened"
    :label="$t('filter.score')"
    :items="DISPLAY_ORDER"
    :selection="scoreFilterData"
    :has="hasScore"
    :value-name="scoreName"
    :typeahead="String"
    :count="scoreCount"
    :option-count="optionCount"
    :share="pct"
    icon="i-tabler-star"
    panel-class="min-w-52"
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
  </FacetFilterPopover>
</template>
