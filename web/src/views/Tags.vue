<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
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
  <div class="h-full flex flex-col">
    <div class="sticky top-0 z-10 border-b border-border-default bg-bg/85 px-4 py-3 backdrop-blur">
      <PInput
        v-model="search"
        placeholder="Search tags"
        class="w-full"
      >
        <template #leftSection>
          <i class="i-tabler-search text-fg-muted" />
        </template>
      </PInput>
    </div>
    <div class="flex-1 overflow-hidden">
      <VirtualScroll
        :items="tagGroupByFirstChar"
        class="h-full"
      >
        <template #default="{ item }">
          <div class="border-b border-border-subtle py-4">
            <div class="flex flex-col">
              <div class="mb-3 flex items-baseline gap-2 px-4">
                <span class="text-2xl font-semibold tracking-tight">
                  {{ item[0] }}
                </span>
                <span class="text-sm text-fg-subtle tabular-nums">
                  {{ item[1].length }}
                </span>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-2 px-4">
                <template
                  v-for="tag, i of item[1]"
                  :key="tag.name"
                >
                  <div
                    v-if="i === 20"
                    class="self-center px-2 text-xs text-fg-subtle"
                  >
                    …
                  </div>
                  <div
                    v-else
                    class="flex items-center gap-1.5"
                  >
                    <PostTag
                      class="cursor-pointer"
                      rounded="lg"
                      :data="tag"
                    >
                      {{ tag.name }}
                    </PostTag>
                    <span class="text-xs text-fg-subtle tabular-nums">
                      {{ tag.count }}
                    </span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>
      </VirtualScroll>
    </div>
  </div>
</template>
