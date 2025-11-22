<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import { TextField } from '@roku-ui/vue'
import { useQuery } from '@tanstack/vue-query'
import { v2ListTags } from '@/api'

const tagQuery = useQuery({
  queryKey: ['tags'],
  queryFn: async () => {
    const resp = await v2ListTags({})
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
  return tagData.value.filter(d => d.name.toLowerCase().includes(search.value.toLowerCase()))
})
const tagGroupByFirstChar = computed(() => {
  const resp: [string, TagWithCountPublic[]][] = []
  for (const d of tagDataSearched.value) {
    if (d.name.length === 0) {
      continue
    }
    const firstChar = d.name[0].toUpperCase()
    const index = resp.findIndex(r => r[0] === firstChar)
    if (index === -1) {
      resp.push([firstChar, [d]])
    }
    else if (resp[index][1].length < 21) {
      resp[index][1].push(d)
    }
  }

  // Sort each group by count in descending order
  for (const group of resp) {
    group[1].sort((a, b) => b.count - a.count)
  }

  // Sort the groups by first character in ascending order
  resp.sort((a, b) => a[0].localeCompare(b[0]))

  return resp
})
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 shadow-sm top-0 sticky z-10">
      <TextField
        v-model="search"
        placeholder="Search tags"
        class="w-full"
      />
    </div>
    <div class="flex-1 overflow-hidden">
      <VirtualScroll
        :items="tagGroupByFirstChar"
        class="h-full"
      >
        <template #default="{ item }">
          <div
            class="border-base py-3 border-b"
          >
            <div class="flex flex-col">
              <div class="mb-3 px-4 flex items-baseline">
                <span class="text-3xl font-bold">
                  {{ item[0] }}
                </span>
                <span class="text-lg ml-2">
                  ({{ item[1].length }})
                </span>
              </div>
              <div class="px-4 flex flex-wrap gap-3">
                <div
                  v-for="tag, i of item[1]"
                  :key="tag.name"
                  class="mb-2 flex gap-2 items-center"
                >
                  <template v-if="i === 20">
                    <div class="text-dimmed px-2 italic">
                      ...
                    </div>
                  </template>
                  <template v-else>
                    <div class="flex gap-2 items-end">
                      <PostTag
                        class="cursor-pointer"
                        rounded="lg"
                        :data="tag"
                      >
                        {{ tag.name }}
                      </PostTag>
                      <span class="text-dimmed text-xs">
                        ({{ tag.count }})
                      </span>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </template>
      </VirtualScroll>
    </div>
  </div>
</template>
