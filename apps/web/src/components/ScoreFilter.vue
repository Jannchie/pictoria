<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetScoreCount } from '@/api'
import { activateOptionOnKey, facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetFilter, useFacetListbox } from '@/composables/useFacetFilter'

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

function scoreName(score: number): string {
  return score === 0 ? t('filter.notScoredYet') : t('filter.star', { n: score }, score)
}

const btnText = computed(() => {
  const item = scoreFilterData.value
  return item.length === 0 ? t('filter.score') : item.map(scoreName).join(', ')
})

const listbox = useTemplateRef<HTMLElement>('listbox')
useFacetListbox(listbox)
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
        <div
          ref="listbox"
          role="listbox"
          aria-multiselectable="true"
          :aria-label="$t('filter.score')"
          class="p-popover-panel min-w-52"
        >
          <!-- Typeahead on the digit: "3" jumps to three stars, "0" to unscored. -->
          <div
            v-for="(score, i) in DISPLAY_ORDER"
            :key="score"
            role="option"
            :aria-selected="hasScore(score)"
            :aria-label="optionLabel(score)"
            :data-typeahead="String(score)"
            :data-autofocus="i === autofocusIndex || undefined"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2 focus-visible:[outline-offset:-2px]"
            @click="toggle(score)"
            @keydown="activateOptionOnKey($event, () => toggle(score))"
          >
            <PCheckbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasScore(score)"
              inert
              aria-hidden="true"
            />
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
            <div
              v-if="scoreCountList[score] || hasScore(score)"
              class="font-mono inline-flex flex-shrink-0 tabular-nums"
            >
              <span class="text-right flex-shrink-0 w-10" :class="scoreCountList[score] ? 'text-fg-muted' : 'text-fg-subtle'">{{ scoreCountList[score] }}</span>
              <span v-if="scoreCountList[score]" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ pct(scoreCountList[score]) }}%</span>
            </div>
          </div>
        </div>
      </template>
    </PPopover>
  </div>
</template>
