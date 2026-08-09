<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetSilvaLunaBucketCount } from '@/api'

// Popover rows (top → bottom); SILVA-Luna shares SILVA's 0–1 scale and edges.
const BUCKETS = [
  { level: 'A', labelKey: 'filter.bucketBest', range: '0.8 – 1.0' },
  { level: 'B', labelKey: 'filter.bucketGood', range: '0.6 – 0.8' },
  { level: 'C', labelKey: 'filter.bucketNormal', range: '0.4 – 0.6' },
  { level: 'D', labelKey: 'filter.bucketBad', range: '0.2 – 0.4' },
  { level: 'E', labelKey: 'filter.bucketWorst', range: '0 – 0.2' },
  { level: 'UNSCORED', labelKey: 'common.unscored', range: '' },
]

async function fetchCounts(filter: PostFilterValue) {
  const resp = await v2GetSilvaLunaBucketCount({ body: filter })
  return resp.data
}
</script>

<template>
  <ScoreBucketFilter
    field="silva_luna_score_levels"
    count-kind="silvaLuna"
    :fetch-counts="fetchCounts"
    :buckets="BUCKETS"
    icon="i-tabler-moon"
    label="filter.silvaLunaScore"
    selected-prefix="Luna"
  />
</template>
