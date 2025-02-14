<script setup lang="ts">
import { v1GetSimilarPosts } from '@/api'
import { baseURL } from '@/shared'
import { useQuery } from '@tanstack/vue-query'

const props = defineProps<{
  postId: number
}>()
const postId = computed(() => props.postId)
const query = useQuery({
  queryKey: ['similarPosts', { postId }],
  queryFn: async () => {
    const resp = await v1GetSimilarPosts({
      path: { post_id: postId.value },
    })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
})
const data = computed(() => query.data.value ?? [])
</script>

<template>
  <div>
    <div v-if="query.isLoading.value">
      Loading...
    </div>
    <div v-else-if="query.isError.value">
      Error: {{ query.error }}
    </div>
    <div v-else-if="query.data">
      <div
        v-for="post in data"
        :key="post.id"
      >
        <img
          :src="`${baseURL}/v1/thumbnails/${post.file_path}/${post.file_name}.${post.extension}?md5=${post.md5}`"
          alt="thumbnail"
        >
      </div>
    </div>
  </div>
</template>
