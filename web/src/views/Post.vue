<script setup lang="ts">
import { selectedPostIdSet } from '@/shared'
import { getPostImageURL } from '@/utils'
import { Btn } from '@roku-ui/vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()
</script>

<template>
  <div
    v-if="post"
    class="h-full flex flex-col"
  >
    <div
      class="flex items-center justify-between border-b bg-surface-base"
    >
      <div class="grow-1 basis-0">
        <Btn
          icon
          variant="transparent"
          color="surface"
          @click="$router.back()"
        >
          <i class="i-tabler-arrow-left" />
        </Btn>
      </div>
      <span class="text-sm">
        {{ post.file_name }}
      </span>
      <span class="grow-1 basis-0" />
    </div>
    <ScrollArea
      ref="scrollAreaRef"
      class="relative h-full w-full flex flex-grow flex-basis-0 flex-col items-center gap-4"
    >
      <div class="h-80% w-fit px-2">
        <img
          :key="post.id"
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
  </div>
</template>
