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
    <!-- px-4!: indent icon/text to the tree rows' 24px left edge (and the
         count to their badges' right edge) while the hover pill stays
         full-width like the tree's. -->
    <PListItem
      class="px-4!"
      icon="i-tabler-photo"
      :title="$t('nav.all')"
      :extra-info="allCount"
      :active="$route.path === '/all'"
      @click="$router.push({ path: '/all', query: $route.query })"
    />
    <PListItem
      class="px-4!"
      icon="i-tabler-bookmarks"
      :title="$t('nav.tagManager')"
      :active="$route.path === '/tags'"
      @click="$router.push('/tags')"
    />
    <PListItem
      class="px-4!"
      icon="i-tabler-clock"
      :title="$t('nav.recently')"
      :active="$route.path === '/recently'"
      @click="$router.push({ path: '/recently', query: $route.query })"
    />
    <PListItem
      class="px-4!"
      icon="i-tabler-arrows-cross"
      :active="$route.path === '/random'"
      :title="$t('nav.random')"
      @click="$router.push({ path: '/random', query: $route.query })"
    />
    <PListItem
      class="px-4!"
      icon="i-tabler-checklist"
      :title="$t('nav.annotate')"
      :active="$route.path === '/annotate'"
      @click="$router.push('/annotate')"
    />
  </div>
</template>
