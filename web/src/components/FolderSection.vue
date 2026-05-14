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
    class="flex shrink-0 flex-wrap gap-2 border-b border-border-subtle px-2 py-2"
  >
    <RouterLink
      v-for="f in subFolders"
      :key="f.value"
      class="max-w-56 min-w-32 flex flex-1 items-center gap-1.5 truncate border border-border-subtle rounded-md bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg"
      :to="`/dir/${f.value}`"
      @pointerdown.stop
    >
      <i class="i-tabler-folder shrink-0 text-primary/70" />
      <span class="flex-grow truncate">
        {{ f.title }}
      </span>
    </RouterLink>
  </div>
</template>
