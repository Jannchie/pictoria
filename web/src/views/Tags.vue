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
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-border-default bg-bg/85 top-0 sticky z-10 backdrop-blur">
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
          <div class="py-4 border-b border-border-subtle">
            <div class="flex flex-col">
              <div class="mb-3 px-4 flex gap-2 items-baseline">
                <span class="text-2xl tracking-tight font-semibold">
                  {{ item[0] }}
                </span>
                <span class="text-sm text-fg-subtle tabular-nums">
                  {{ item[1].length }}
                </span>
              </div>
              <div class="px-4 flex flex-wrap gap-x-3 gap-y-2">
                <template
                  v-for="tag, i of item[1]"
                  :key="tag.name"
                >
                  <div
                    v-if="i === 20"
                    class="text-xs text-fg-subtle px-2 self-center"
                  >
                    …
                  </div>
                  <div
                    v-else
                    class="flex gap-1.5 items-center"
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
