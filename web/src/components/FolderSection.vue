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
    class="px-1 py-2 flex shrink-0 flex-wrap gap-2 overflow-y-auto"
  >
    <RouterLink
      v-for="f in subFolders"
      :key="f.value"
      class="bg-surface-variant-1 text-xs px-3 py-2 rounded flex basis-[calc(10%-0.5rem)] gap-1 truncate items-center hover:bg-surface-variant-1 hover:bg-surface-variant-2"
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
