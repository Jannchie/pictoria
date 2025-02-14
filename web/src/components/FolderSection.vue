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
    class="max-h-200px flex flex-wrap gap-2 overflow-y-auto py-2"
  >
    <RouterLink
      v-for="f in subFolders"
      :key="f.value"
      class="flex basis-[calc(25%-0.5rem)] items-center gap-1 truncate border border-surface rounded hover:bg-surface-variant-1 px-2 py-1 text-xs"
      :to="`/dir/${f.value}`"
    >
      <i class="i-tabler-folder shrink-0" />
      <span class="flex-grow truncate">
        {{ f.title }}
      </span>
    </RouterLink>
  </div>
  <div
    v-if="subFolders.length > 0"
    class="border-b-1"
  />
</template>
