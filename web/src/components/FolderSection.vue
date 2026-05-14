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
  <div
    v-if="subFolders.length > 0"
    class="px-2 py-2 border-b border-border-subtle flex shrink-0 flex-wrap gap-2"
  >
    <RouterLink
      v-for="f in subFolders"
      :key="f.value"
      class="text-xs text-fg-muted px-3 py-1.5 border border-border-subtle rounded-md bg-surface-1 flex flex-1 gap-1.5 max-w-56 min-w-32 truncate transition-colors items-center hover:text-fg hover:border-border-strong hover:bg-surface-2"
      :to="`/dir/${f.value}`"
      @pointerdown.stop
    >
      <i class="i-tabler-folder text-primary/70 shrink-0" />
      <span class="flex-grow truncate">
        {{ f.title }}
      </span>
    </RouterLink>
  </div>
</template>
