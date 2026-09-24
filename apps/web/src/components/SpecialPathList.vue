<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { v2GetPostsCount } from '@/api'
import { formatNumber } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

// Label keys (not resolved strings) so a locale switch re-renders them. The
// gallery views carry the current filter query along; the others start clean.
const items: { path: string, icon: string, labelKey: string, keepQuery: boolean }[] = [
  { path: '/all', icon: 'i-tabler-photo', labelKey: 'nav.all', keepQuery: true },
  { path: '/tags', icon: 'i-tabler-bookmarks', labelKey: 'nav.tagManager', keepQuery: false },
  { path: '/recently', icon: 'i-tabler-clock', labelKey: 'nav.recently', keepQuery: true },
  { path: '/random', icon: 'i-tabler-arrows-cross', labelKey: 'nav.random', keepQuery: true },
  { path: '/annotate', icon: 'i-tabler-checklist', labelKey: 'nav.annotate', keepQuery: false },
]

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
  <!-- Real links (RouterLink → <a href>): keyboard activation, middle-click /
       open-in-new-tab, and aria-current="page" on the exact route come for
       free. The PListItem inside is only the visual row. -->
  <ul class="text-sm flex flex-col gap-1 select-none">
    <li v-for="item in items" :key="item.path">
      <RouterLink
        :to="item.keepQuery ? { path: item.path, query: $route.query } : item.path"
        class="rounded block"
        :aria-current="$route.path === item.path ? 'page' : undefined"
      >
        <!-- px-4!: indent icon/text to the tree rows' 24px left edge (and the
             count to their badges' right edge) while the hover pill stays
             full-width like the tree's. -->
        <PListItem
          class="px-4!"
          :icon="item.icon"
          :title="$t(item.labelKey)"
          :extra-info="item.path === '/all' && allCount != null ? formatNumber(allCount) : undefined"
          :active="$route.path === item.path"
        />
      </RouterLink>
    </li>
  </ul>
</template>
