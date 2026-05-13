<script setup lang="ts">
import { useRoute } from 'vue-router'
import { bottomBarInfo, selectedPostIdSet, usePosts } from '@/shared'

const posts = usePosts()
const route = useRoute()
</script>

<template>
  <div
    class="h-24px flex shrink-0 items-center gap-4 border-t border-border-default bg-bg px-3 text-xs text-fg-muted"
  >
    <template v-if="route.name === 'all' || route.name === 'dir'">
      <span class="flex items-center gap-1">
        <i class="i-tabler-photo text-fg-subtle" />
        <span class="font-mono tabular-nums">{{ posts.length }}</span>
        <span class="text-fg-subtle">displayed</span>
      </span>
      <span
        v-if="selectedPostIdSet.size > 0"
        class="flex items-center gap-1 text-primary"
      >
        <i class="i-tabler-checks" />
        <span class="font-mono tabular-nums">{{ selectedPostIdSet.size }}</span>
        <span>selected</span>
      </span>
    </template>
    <template v-else>
      {{ bottomBarInfo }}
    </template>
  </div>
</template>
