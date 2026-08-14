<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetSilvaBucketCount } from '@/api'

// Popover rows (top → bottom); SILVA scores live on a 0–1 scale.
const BUCKETS = [
  { level: 'A', labelKey: 'filter.bucketBest', range: '0.8 – 1.0' },
  { level: 'B', labelKey: 'filter.bucketGood', range: '0.6 – 0.8' },
  { level: 'C', labelKey: 'filter.bucketNormal', range: '0.4 – 0.6' },
  { level: 'D', labelKey: 'filter.bucketBad', range: '0.2 – 0.4' },
  { level: 'E', labelKey: 'filter.bucketWorst', range: '0 – 0.2' },
  { level: 'UNSCORED', labelKey: 'common.unscored', range: '' },
]

async function fetchCounts(filter: PostFilterValue) {
  const resp = await v2GetSilvaBucketCount({ body: filter })
  return resp.data
}
</script>

<template>
  <ScoreBucketFilter
    field="silva_score_levels"
    count-kind="silva"
    :fetch-counts="fetchCounts"
    :buckets="BUCKETS"
    icon="i-tabler-rosette"
    :label="$t('filter.silvaScore')"
    selected-prefix="SILVA"
  />
</template>
