<script setup lang="ts">
import { selectedPostIdSet, usePosts } from '@/shared'

const posts = usePosts()
</script>

<template>
  <div
    class="h-24px flex items-center border-t border-surface bg-surface px-1 text-xs text-surface-dimmed"
  >
    All: {{ posts.length }}, Selected: {{ selectedPostIdSet.size }}
  </div>
</template>
