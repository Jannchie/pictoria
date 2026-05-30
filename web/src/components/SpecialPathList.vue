<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { v2GetPostsCount } from '@/api'
import { queryKeys } from '@/shared/queryKeys'

const { data: allCount } = useQuery({
  queryKey: queryKeys.postCount,
  queryFn: async () => {
    const resp = await v2GetPostsCount({
      body: {},
    })
    return (resp.data as any).count
  },
})
</script>

<template>
  <div class="text-sm flex flex-col gap-1 select-none">
    <ListItem
      icon="i-tabler-photo"
      title="All"
      :extra-info="allCount"
      :active="$route.path === '/all'"
      @click="$router.push({ path: '/all', query: $route.query })"
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
      :active="$route.path === '/recently'"
      @click="$router.push({ path: '/recently', query: $route.query })"
    />
    <ListItem
      icon="i-tabler-arrows-cross"
      :active="$route.path === '/random'"
      title="Random"
      @click="$router.push({ path: '/random', query: $route.query })"
    />
  </div>
</template>
