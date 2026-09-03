<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetWaifuBucketCount } from '@/api'
import { bucketRows } from '@/shared'

// 行序、level、labelKey 全部来自 @/shared 的分档表；这里只给数值区间。
const BUCKETS = bucketRows({ A: '8 – 10', B: '6 – 8', C: '4 – 6', D: '2 – 4', E: '0 – 2' })

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
