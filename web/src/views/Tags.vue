<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { v2ListTags } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

const tagQuery = useQuery({
  // Locale appended: translated tag names come from the server, so a
  // language switch refetches. invalidateQueries(queryKeys.tags) still
  // matches by prefix.
  queryKey: [...queryKeys.tags, resolvedLocale],
  queryFn: async () => {
    const resp = await v2ListTags({ query: { lang: resolvedLocale.value } })
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
    else {
      resp[index][1].push(d)
    }
  }

  for (const group of resp) {
    group[1].sort((a, b) => b.count - a.count)
  }

  resp.sort((a, b) => a[0].localeCompare(b[0]))

  return resp
})
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-border-default bg-bg/85 top-0 sticky z-10 backdrop-blur">
      <PInput
        v-model="search"
        :placeholder="$t('tagsView.searchPlaceholder')"
        :aria-label="$t('tagsView.searchAria')"
        block
      >
        <template #leftSection>
          <i class="i-tabler-search text-fg-muted" aria-hidden="true" />
        </template>
      </PInput>
    </div>
    <div
      v-if="tagQuery.isLoading.value"
      role="status"
      class="p-16 text-center op-50 flex flex-col gap-2 items-center"
    >
      <i class="i-tabler-loader text-2xl animate-spin" aria-hidden="true" />
      <div class="text-sm">
        {{ $t('tagsView.loading') }}
      </div>
    </div>
    <div
      v-else-if="tagQuery.error.value"
      role="alert"
      class="text-danger p-16 text-center op-80 flex flex-col gap-2 items-center"
    >
      <i class="i-tabler-alert-circle text-2xl" aria-hidden="true" />
      <div class="text-sm">
        {{ $t('tagsView.loadFailed') }}
      </div>
    </div>
    <div
      v-else-if="tagGroupByFirstChar.length === 0"
      class="p-16 text-center op-50 flex flex-col gap-2 items-center"
    >
      <i class="i-tabler-mood-empty text-2xl" aria-hidden="true" />
      <div class="text-sm">
        {{ $t('tagsView.noMatch', { search }) }}
      </div>
    </div>
    <div v-else class="flex-1 overflow-hidden">
      <VirtualScroll
        :items="tagGroupByFirstChar"
        class="h-full"
      >
        <template #default="{ item }">
          <section :aria-labelledby="`tag-group-${item[0]}`" class="py-4 border-b border-border-subtle">
            <div class="flex flex-col">
              <div class="mb-3 px-4 flex gap-2 items-baseline">
                <h2
                  :id="`tag-group-${item[0]}`"
                  class="text-2xl tracking-tight font-semibold text-pretty"
                  style="scroll-margin-top: 4rem;"
                >
                  {{ item[0] }}
                </h2>
                <span class="text-sm text-fg-subtle tabular-nums">
                  {{ item[1].length }}
                </span>
              </div>
              <ul class="px-4 list-none flex flex-wrap gap-x-3 gap-y-2">
                <li
                  v-for="tag of item[1]"
                  :key="tag.name"
                  class="flex gap-1.5 items-center"
                >
                  <PostTag
                    class="cursor-pointer"
                    rounded="lg"
                    :data="tag"
                  />
                  <span class="text-xs text-fg-subtle tabular-nums">
                    {{ tag.count }}
                  </span>
                </li>
              </ul>
            </div>
          </section>
        </template>
      </VirtualScroll>
    </div>
  </div>
</template>
