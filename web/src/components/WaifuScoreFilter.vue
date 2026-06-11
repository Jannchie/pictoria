<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetWaifuBucketCount } from '@/api'

// Popover rows (top → bottom); waifu scores live on a 0–10 scale.
const BUCKETS = [
  { level: 'A', labelKey: 'filter.bucketBest', range: '8 – 10' },
  { level: 'B', labelKey: 'filter.bucketGood', range: '6 – 8' },
  { level: 'C', labelKey: 'filter.bucketNormal', range: '4 – 6' },
  { level: 'D', labelKey: 'filter.bucketBad', range: '2 – 4' },
  { level: 'E', labelKey: 'filter.bucketWorst', range: '0 – 2' },
  { level: 'UNSCORED', labelKey: 'common.unscored', range: '' },
]

async function fetchCounts(filter: PostFilterValue) {
  const resp = await v2GetWaifuBucketCount({ body: filter })
  return resp.data
}
</script>

<template>
  <ScoreBucketFilter
    field="waifu_score_levels"
    count-kind="waifu"
    :fetch-counts="fetchCounts"
    :buckets="BUCKETS"
    icon="i-tabler-crown"
    :label="$t('filter.waifuScore')"
    selected-prefix="Waifu"
  />
</template>
