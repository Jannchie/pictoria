<script setup lang="ts">
import { showPostDetail, waterfallRowCount } from '@/shared'
import PostDetail from '../components/PostDetail.vue'
import 'splitpanes/dist/splitpanes.css'

// Ctrl+wheel zooms the grid; the matching slider lives in FilterRow's right
// cluster so the gallery header is a single row.
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
    <header class="flex shrink-0 flex-col">
      <FilterRow />
    </header>
    <MainSection />
  </div>
</template>
