<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { v2DeletePosts } from '@/api'
import { selectedPostIdSet, showPostDetail, waterfallRowCount } from '@/shared'
import PostDetail from '../components/PostDetail.vue'
import 'splitpanes/dist/splitpanes.css'

const queryClient = useQueryClient()

async function deleteSelectingPosts() {
  for (const post_id of selectedPostIdSet.value) {
    if (post_id === undefined) {
      continue
    }
    await v2DeletePosts({
      query: {
        ids: [post_id],
      },
    })
  }
  queryClient.invalidateQueries({ queryKey: ['posts'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'rating'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'extension'] })
}
onKeyStroke('Delete', deleteSelectingPosts)

useEventListener('wheel', (event) => {
  if (event.ctrlKey) {
    event.preventDefault()
    waterfallRowCount.value = event.deltaY > 0 ? Math.min(waterfallRowCount.value + 1, 16) : Math.max(waterfallRowCount.value - 1, 1)
  }
}, { passive: false })
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
  />
  <div class="flex flex-col h-full">
    <header
      class="flex shrink-0 flex-col h-60px items-center justify-center"
    >
      <div class="flex flex-grow w-32 items-center justify-center">
        <Slider
          v-model="waterfallRowCount"
          size="sm"
          :min="1"
          :max="16"
          :min-width="0"
          :tick-num="0"
          reverse
        />
      </div>
      <FilterRow />
    </header>
    <MainSection />
  </div>
</template>
