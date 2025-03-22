<script setup lang="ts">
import { bottomBarInfo, selectedPostIdSet, usePosts } from '@/shared'
import { useRoute } from 'vue-router'

const posts = usePosts()
const route = useRoute()
</script>

<template>
  <div
    class="h-24px flex items-center border-t border-surface bg-surface px-1 text-xs text-surface-dimmed"
  >
    <template v-if="route.name === 'all' || route.name === 'dir'">
      Display: {{ posts.length }}, Selected: {{ selectedPostIdSet.size }}
    </template>
    <template v-else>
      {{ bottomBarInfo }}
    </template>
  </div>
</template>
