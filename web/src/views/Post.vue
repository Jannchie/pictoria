<script setup lang="ts">
import type { PostPublic } from '@/api'
import Image from '@/roku/Image.vue'
import { bottomBarInfo, selectedPostIdSet } from '@/shared'
import { getPostImageURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'
import { Btn } from '@roku-ui/vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()

function getPostColor(post: PostPublic) {
  if (post.colors.length > 0) {
    return colorNumToHex([...post.colors].sort((a, b) => {
      return a.order - b.order
    })[0].color)
  }
  return 'primary'
}

watchEffect(() => {
  if (postQuery.data.value) {
    bottomBarInfo.value = `Post ID: ${postQuery.data.value.id}, File Name: ${postQuery.data.value.file_name}`
  }
})
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
      <div class="max-h-80% px-2 pt-3">
        <Image
          :key="post.id"
          :src="getPostImageURL(post)"
          alt="post"
          :color="getPostColor(post)"
          rounded="lg"
          @click=" selectedPostIdSet = new Set([post.id])"
        />
      </div>
      <SimilarPosts
        v-if="scrollAreaRef"
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </ScrollArea>
  </div>
</template>
