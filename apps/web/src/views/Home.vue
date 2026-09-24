<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { showPostDetail, waterfallRowCount } from '@/shared'
import PostDetail from '../components/PostDetail.vue'
import 'splitpanes/dist/splitpanes.css'

const { t } = useI18n()
const route = useRoute()

// Ctrl+wheel zooms the grid; the matching slider lives in FilterRow's right
// cluster so the gallery header is a single row.
useEventListener('wheel', (event) => {
  if (event.ctrlKey) {
    event.preventDefault()
    waterfallRowCount.value = event.deltaY > 0 ? Math.min(waterfallRowCount.value + 1, 16) : Math.max(waterfallRowCount.value - 1, 1)
  }
}, { passive: false })

// 画廊页的一级标题（视觉隐藏，给读屏的标题导航用）：目录路由显示目录路径，
// 其余画廊路由用侧栏里同名入口的文案。
const heading = computed(() => {
  if (route.name === 'dir') {
    const raw = route.params.folder
    const folder = Array.isArray(raw) ? raw.join('/') : (raw ?? '')
    if (folder) {
      return folder
    }
  }
  if (route.name === 'recently') {
    return t('nav.recently')
  }
  if (route.path === '/random') {
    return t('nav.random')
  }
  return t('nav.all')
})
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
  />
  <!-- 查看器打开时它盖住整个画廊：画廊 inert，Tab 从查看器直接走到右侧面板。 -->
  <div
    class="flex flex-col h-full"
    :inert="showPostDetail != null"
  >
    <h1 class="sr-only">
      {{ heading }}
    </h1>
    <header class="flex shrink-0 flex-col">
      <FilterRow />
    </header>
    <MainSection />
  </div>
</template>
