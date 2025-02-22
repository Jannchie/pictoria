<script setup lang="ts">
import { selectedPostIdSet } from '@/shared'
import { getPostImageURL } from '@/utils'
import { useRoute } from 'vue-router'

const route = useRoute()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()
</script>

<template>
  <ScrollArea
    v-if="post"
    ref="scrollAreaRef"
    class="relative h-full w-full flex flex-col items-center gap-4"
  >
    <div class="h-80% w-fit">
      <img
        :src="getPostImageURL(post)"
        alt="post"
        class="h-full w-full overflow-hidden rounded-lg object-contain"
        @click=" selectedPostIdSet = new Set([post.id])"
      >
    </div>
    <SimilarPosts
      v-if="scrollAreaRef"
      :post-id="post.id"
      :scroll-element="scrollAreaRef"
    />
  </ScrollArea>
</template>
