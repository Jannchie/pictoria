<script setup lang="ts">
import { useCurrentFolder, useFoldersQuery } from '@/shared'

const currentFolder = useCurrentFolder()
const foldersQuery = useFoldersQuery()

const subFolders = computed(() => {
  // 寻找 currentFolder 下的直属子文件夹
  if (currentFolder.value === '@') {
    return (foldersQuery.data.value?.children ?? []).map((f) => {
      return {
        title: f.name,
        value: f.path,
      }
    })
  }
  const folders = foldersQuery.data.value?.children ?? []
  const folder = folders.find(f => f.path === currentFolder.value)
  return (folder?.children ?? []).map((f) => {
    return {
      title: f.name,
      value: f.path,
    }
  })
})
</script>

<template>
  <!-- Sub-folder shortcuts above the grid: text rows with a folder glyph, no
       card chrome — they are navigation, and must not compete with the
       thumbnails directly below. -->
  <div
    v-if="subFolders.length > 0"
    class="px-3 pb-1 pt-2 flex shrink-0 flex-wrap gap-x-1 gap-y-0.5"
  >
    <RouterLink
      v-for="f in subFolders"
      :key="f.value"
      class="text-xs text-fg-muted px-2 py-1 border border-border-subtle rounded-md flex gap-1.5 max-w-56 min-w-0 truncate transition-colors items-center hover:text-fg hover:border-border-default hover:bg-surface-1"
      :to="{ path: `/dir/${f.value}`, query: $route.query }"
      @pointerdown.stop
    >
      <i class="i-tabler-folder text-fg-subtle shrink-0" aria-hidden="true" />
      <span class="truncate">
        {{ f.title }}
      </span>
    </RouterLink>
  </div>
</template>
