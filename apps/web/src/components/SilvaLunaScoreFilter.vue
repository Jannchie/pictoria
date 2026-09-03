<script setup lang="ts">
import type { PostFilterValue } from '@/composables/useFacetFilter'
import { v2GetSilvaLunaBucketCount } from '@/api'
import { bucketRows } from '@/shared'

// 行序、level、labelKey 全部来自 @/shared 的分档表；这里只给数值区间。
const BUCKETS = bucketRows({ A: '0.8 – 1.0', B: '0.6 – 0.8', C: '0.4 – 0.6', D: '0.2 – 0.4', E: '0 – 0.2' })

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
    :label="$t('filter.silvaLunaScore')"
    selected-prefix="Luna"
  />
</template>
