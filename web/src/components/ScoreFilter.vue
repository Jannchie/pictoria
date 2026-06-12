<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetScoreCount } from '@/api'
import { useFacetFilter } from '@/composables/useFacetFilter'

const { t } = useI18n()

const { selected: scoreFilterData, has: hasScore, toggle, countQuery, pct } = useFacetFilter<number, { score: number, count: number }>({
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

const btnText = computed(() => {
  const item = scoreFilterData.value
  return item.length === 0 ? t('filter.score') : item.map(s => s === 0 ? t('filter.notScoredYet') : t('filter.star', { n: s }, s)).join(', ')
})
</script>

<template>
  <div class="relative">
    <PPopover position="bottom-start">
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
          class="p-popover-panel min-w-52"
        >
          <div
            v-for="score in [5, 4, 3, 2, 1, 0]"
            :key="score"
            class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
            @pointerdown="toggle(score)"
          >
            <PCheckbox
              class="flex-shrink-0 pointer-events-none"
              :model-value="hasScore(score)"
            />
            <div class="flex flex-grow gap-1 items-center">
              <template v-if="score === 0">
                <span class="text-fg-subtle italic">{{ $t('common.unscored') }}</span>
              </template>
              <template v-else>
                <i
                  v-for="i in score"
                  :key="i"
                  class="i-tabler-star-filled text-warning"
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
