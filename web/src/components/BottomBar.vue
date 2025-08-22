<script setup lang="ts">
import { useRoute } from 'vue-router'
import { bottomBarInfo, selectedPostIdSet, usePosts } from '@/shared'

const posts = usePosts()
const route = useRoute()
</script>

<template>
  <div
    class="text-xs text-surface-dimmed px-1 border-t border-surface bg-surface flex h-24px items-center"
  >
    <template v-if="route.name === 'all' || route.name === 'dir'">
      Display: {{ posts.length }}, Selected: {{ selectedPostIdSet.size }}
    </template>
    <template v-else>
      {{ bottomBarInfo }}
    </template>
  </div>
</template>
