<script setup lang="ts">
import type { DirectorySummary } from '@/api'
import { v1GetFolders } from '@/api'
import { } from '@/shared'
import { Btn } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const folders = useQuery({
  queryKey: ['folders'],
  queryFn: async () => {
    const resp = await v1GetFolders({ })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  staleTime: 1000 * 60 * 60,
})

const route = useRoute()
const currentPath = computed(() => {
  if (typeof route.params.folder === 'string') {
    return route.params.folder
  }
  return route.params.folder.join('/')
})

function findChildrenByPath(folders: DirectorySummary, targetPath: string): DirectorySummary[] | null {
  if (!folders) {
    return null
  }
  if (folders.path === targetPath) {
    return folders.children ?? []
  }
  if (folders.children) {
    for (const child of folders.children) {
      const result = findChildrenByPath(child, targetPath)
      if (result !== null) {
        return result
      }
    }
  }
  return null
}

const childFolders = computed(() => {
  const f = folders.data.value
  if (!f) {
    return []
  }
  const children = findChildrenByPath(f, currentPath.value)
  return children ?? []
})
</script>

<template>
  <div class="flex flex-wrap gap-2 children:w-[calc(25%-0.5rem)]">
    <Btn
      v-for="folder in childFolders"
      :key="folder.path"
    >
      {{ folder.name }}
    </Btn>
  </div>
</template>
