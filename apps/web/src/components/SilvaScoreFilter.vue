<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetSilvaBucketCount } from '@/api'
import { bucketRows } from '@/shared'

// 行序、level、labelKey 全部来自 @/shared 的分档表；这里只给数值区间。
const BUCKETS = bucketRows({ A: '0.8 – 1.0', B: '0.6 – 0.8', C: '0.4 – 0.6', D: '0.2 – 0.4', E: '0 – 0.2' })

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
