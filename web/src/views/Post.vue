<script setup lang="ts">
import { useRoute } from 'vue-router'
import PostDetail from '@/components/PostDetail.vue'
import Image from '@/roku/Image.vue'
import { bottomBarInfo, showPostDetail } from '@/shared'
import { getPostImageURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'

const route = useRoute()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()

function getPostColor(post: { colors: { color: number, order: number }[] }) {
  if (post.colors && post.colors.length > 0) {
    return colorNumToHex(post.colors.toSorted((a, b) => {
      return a.order - b.order
    })[0].color)
  }
  return 'primary'
}

watchEffect(() => {
  if (postQuery.data.value) {
    bottomBarInfo.value = `Post ID: ${postQuery.data.value.id}, File Name: ${postQuery.data.value.fileName}`
  }
})
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
  />
  <div
    v-if="post"
    class="h-full flex flex-col"
  >
    <div
      class="flex items-center justify-between gap-2 border-b border-border-default bg-bg px-2 py-1"
    >
      <div class="flex flex-1 basis-0 items-center">
        <PButton
          icon
          size="sm"
          variant="ghost"
          @click="$router.back()"
        >
          <i class="i-tabler-arrow-left" />
        </PButton>
      </div>
      <span class="min-w-0 truncate text-sm text-fg font-medium">
        {{ post.fileName }}
      </span>
      <span class="flex-1 basis-0" />
    </div>
    <ScrollArea
      ref="scrollAreaRef"
      class="relative h-full w-full flex flex-grow flex-basis-0 flex-col gap-4"
    >
      <div class="mx-auto max-h-80% px-2 pt-3">
        <Image
          :key="post.id"
          :src="getPostImageURL(post)"
          alt="post"
          :color="getPostColor(post)"
          rounded="lg"
          class="cursor-pointer"
          @click="showPostDetail = { ...post, width: post.width ?? 0, height: post.height ?? 0 }"
        />
      </div>
      <SimilarPosts
        v-if="scrollAreaRef"
        class="w-full"
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </ScrollArea>
  </div>
</template>
