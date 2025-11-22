<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { v2GetSimilarPosts } from '@/api'

const props = defineProps<{
  postId: number
  scrollElement: MaybeRef<HTMLElement>
}>()
const scrollElement = computed(() => props.scrollElement ?? document.documentElement)
const postId = computed(() => props.postId)
const query = useQuery({
  queryKey: ['similarPosts', { postId }],
  queryFn: async () => {
    const resp = await v2GetSimilarPosts({
      path: { post_id: postId.value },
    })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
})

const data = computed(() => query.data.value ?? [])
const width = useClientWidth(scrollElement as any)
const cols = computed(() => Math.floor(width.value / 300))
</script>

<template>
  <template v-if="query.status.value === 'pending'">
    <div class="text-dimmed text-sm flex flex-col gap-2 h-64 items-center justify-center">
      <i
        class="i-svg-spinners-90-ring-with-bg text-highlight text-3xl"
      />
      <span>
        Loading similar posts...
      </span>
    </div>
  </template>
  <LazyWaterfall
    v-else
    :scroll-element="scrollElement"
    :items="data.map(p => ({ width: p.width ?? 1, height: p.height ?? 1 }))"
    :cols="cols"
    :gap="24"
    :padding-x="8"
    :padding-y="8"
    :y-gap="36"
  >
    <PostItem
      v-for="p in data"
      :id="`post-item-${p.id}`"
      :key="p.id"
      :post="p"
    />
  </LazyWaterfall>
</template>
