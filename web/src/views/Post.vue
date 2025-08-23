<script setup lang="ts">
import { Btn } from '@roku-ui/vue'
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
    return colorNumToHex([...post.colors].sort((a, b) => {
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
    class="flex flex-col h-full"
  >
    <div
      class="border-b bg-surface-base flex items-center justify-between"
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
        {{ post.fileName }}
      </span>
      <span class="grow-1 basis-0" />
    </div>
    <ScrollArea
      ref="scrollAreaRef"
      class="flex flex-grow flex-basis-0 flex-col gap-4 h-full w-full items-center relative"
    >
      <div class="px-2 pt-3 max-h-80%">
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
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </ScrollArea>
  </div>
</template>
