<script setup lang="ts">
import { v2GetPostsCount } from '@/api'
import { useQuery } from '@tanstack/vue-query'

const { data: allCount } = useQuery({
  queryKey: ['post-count'],
  queryFn: async () => {
    const resp = await v2GetPostsCount({
      body: {},
    })
    return (resp.data as any).count
  },
})
</script>

<template>
  <div class="flex flex-col select-none gap-1 text-sm">
    <ListItem
      icon="i-tabler-photo"
      title="All"
      :extra-info="allCount"
      :active="$route.path === '/all'"
      @click="$router.push('/all')"
    />
    <ListItem
      icon="i-tabler-bookmarks"
      title="Tag Manager"
      :active="$route.path === '/tags'"
      @click="$router.push('/tags')"
    />
    <ListItem
      icon="i-tabler-clock"
      title="Recently"
    />
    <ListItem
      icon="i-tabler-arrows-cross"
      :active="$route.path === '/random'"
      title="Random"
      @click="$router.push('/random')"
    />
  </div>
</template>
