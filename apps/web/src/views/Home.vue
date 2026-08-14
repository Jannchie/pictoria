<script setup lang="ts">
import { showPostDetail, waterfallRowCount } from '@/shared'
import PostDetail from '../components/PostDetail.vue'
import 'splitpanes/dist/splitpanes.css'

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
      <div class="px-2 pt-1 flex shrink-0 h-8 items-center justify-center">
        <div class="text-fg-subtle flex gap-2 w-40 items-center">
          <i class="i-tabler-grid-dots text-sm shrink-0" aria-hidden="true" />
          <PSlider
            v-model="waterfallRowCount"
            size="sm"
            :min="1"
            :max="16"
            :min-width="0"
            :tick-num="0"
            reverse
            :aria-label="$t('gallery.columnsAria')"
            :aria-valuetext="$t('gallery.columnsValue', { n: waterfallRowCount })"
          />
        </div>
      </div>
      <FilterRow />
    </header>
    <MainSection />
  </div>
</template>
