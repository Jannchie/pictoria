<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import { v1GetTags } from '@/api'
import { TextField } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'

const tagQuery = useQuery({
  queryKey: ['tags'],
  queryFn: async () => {
    const resp = await v1GetTags({ })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
})

const search = ref('')
const tagData = computed(() => {
  return tagQuery.data.value?.map(d => ({ ...d })) ?? []
})
const tagDataSearched = computed(() => {
  return tagData.value.filter(d => d.tag_info.name.toLowerCase().includes(search.value.toLowerCase()))
})
const tagGroupByFirstChar = computed(() => {
  const resp: [string, TagWithCountPublic[]][] = []
  tagDataSearched.value.forEach((d) => {
    if (d.tag_info.name.length === 0) {
      return
    }
    const firstChar = d.tag_info.name[0].toUpperCase()
    const index = resp.findIndex(r => r[0] === firstChar)
    if (index === -1) {
      resp.push([firstChar, [d]])
    }
    else {
      resp[index][1].push(d)
    }
  })
  return resp
})
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="mt-2 px-1">
      <TextField
        v-model="search"
        placeholder="Search"
      />
    </div>
    <VirtualScroll
      :items="tagGroupByFirstChar"
    >
      <template #default="{ item }">
        <div
          class="border-b-surface-high border-b py-2"
        >
          <div
            class="flex flex-col text-sm"
          >
            <div class="mb-2 mt-3 px-2 text-3xl">
              {{ item[0] }}
              <span class="text-xl">
                ({{ item[1].length }})
              </span>
            </div>
            <div class="flex flex-wrap gap-3 px-2 text-xs">
              <div
                v-for="tag of item[1]"
                :key="tag.tag_info.name"
                class="flex items-end gap-1"
              >
                <PostTag
                  class="cursor-pointer"
                  rounded="lg"
                  :data="tag"
                >
                  {{ tag.tag_info.name }}
                </PostTag>
                <span class="op-75">
                  ({{ tag.count }})
                </span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </VirtualScroll>
  </div>
</template>
