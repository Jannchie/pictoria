<script setup lang="ts">
import type { TagCountRequest } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { useDebounce } from '@vueuse/core'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetPostsCount, v2GetTagCount } from '@/api'
import { resolvedLocale } from '@/locale'
import { postFilter, queryKeys } from '@/shared'
import { naturalizeTagName } from '@/utils'

const { t } = useI18n()

// Max tags fetched per query (top-N by count). The search box narrows the set
// server-side, so rare tags outside this window stay reachable by typing.
const TAG_LIMIT = 50

// Tags don't use useFacetFilter like the other facets: they're numerous and
// need a search box, so the count query below is search-aware rather than the
// abstraction's single filter-keyed query. The selection wiring is the same
// shape, inlined here.
const selected = computed<string[]>({
  get: () => postFilter.value.tags,
  set: (value) => {
    postFilter.value.tags = value
  },
})
function has(tag: string): boolean {
  return selected.value.includes(tag)
}
function toggle(tag: string): void {
  selected.value = has(tag)
    ? selected.value.filter(t => t !== tag)
    : [...selected.value, tag]
}

// Counts show how many posts each tag *would* match if the tag facet were
// cleared, so zero out tags before counting — same convention as the other
// facets (each facet's counts ignore its own current selection).
const filterWithoutSelf = computed(() => ({ ...postFilter.value, tags: [] }))

const search = ref('')
const debouncedSearch = useDebounce(search, 250)

// The tag-count GROUP BY is heavier than the other (single-column) facet
// counts, so bind this to the Popover's open state (v-model below) and only
// run the queries while the dropdown is actually open.
const opened = ref(false)

const countQuery = useQuery({
  // Key on the without-self filter, the debounced query, and the locale so
  // typing refetches, each search string caches independently, and a
  // language switch refreshes the server-side translated names.
  queryKey: queryKeys.count('tags', computed(() => ({ filter: filterWithoutSelf.value, q: debouncedSearch.value, lang: resolvedLocale.value }))),
  queryFn: async () => {
    const body: TagCountRequest = { ...filterWithoutSelf.value, query: debouncedSearch.value, limit: TAG_LIMIT, lang: resolvedLocale.value }
    const resp = await v2GetTagCount({ body })
    return resp.data
  },
  enabled: opened,
})

// Denominator for the per-tag percentage: the number of posts matching the
// current filter (tags facet cleared). Tags aren't mutually exclusive, so —
// unlike the other facets — the counts don't sum to the post total; dividing by
// it makes the '%' read as "share of these posts that carry this tag".
const postTotalQuery = useQuery({
  queryKey: computed(() => ['count', 'tags-total', filterWithoutSelf.value]),
  queryFn: async () => {
    const resp = await v2GetPostsCount({ body: filterWithoutSelf.value })
    return resp.data?.count ?? 0
  },
  enabled: opened,
})

const countMap = computed(() => {
  const map: Record<string, number> = {}
  for (const d of countQuery.data.value ?? []) {
    map[d.tag_name] = d.count
  }
  return map
})

// 本地化显示名（来自 count 响应）；搜索/筛选仍以原始下划线名为准。
const translationMap = computed(() => {
  const map: Record<string, string> = {}
  for (const d of countQuery.data.value ?? []) {
    if (d.translated_name) {
      map[d.tag_name] = d.translated_name
    }
  }
  return map
})
const total = computed(() => postTotalQuery.data.value ?? 0)
function pct(count: number): string {
  return total.value > 0 ? ((count / total.value) * 100).toFixed(1) : '0.0'
}

// Pin selected tags at the top so they stay un-checkable even when they fall
// outside the current top-N / search results.
const tagRows = computed(() => {
  const fromApi = (countQuery.data.value ?? []).map(d => d.tag_name)
  return [...new Set([...selected.value, ...fromApi])]
})

const isLoading = computed(() => countQuery.isLoading.value)
const btnText = computed(() => (selected.value.length === 0 ? t('filter.tags') : selected.value.map(naturalizeTagName).join(', ')))
</script>

<template>
  <div class="relative">
    <Popover
      v-model="opened"
      position="bottom-start"
    >
      <PButton size="sm">
        <i class="i-tabler-tag" />
        <!-- leading-normal: the button sets line-height:1, and `truncate`
             (overflow:hidden) would otherwise clip glyph descenders (e.g. "g"). -->
        <span class="leading-normal flex-grow max-w-40 truncate">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div class="p-1 border border-border-default rounded bg-surface min-w-64 shadow-lg">
          <div class="mb-2">
            <PInput
              v-model="search"
              size="sm"
              block
              :placeholder="$t('filter.searchTagsPlaceholder')"
              :aria-label="$t('filter.searchTags')"
            >
              <template #leftSection>
                <i class="i-tabler-search text-fg-muted" aria-hidden="true" />
              </template>
            </PInput>
          </div>
          <div class="max-h-72 overflow-y-auto">
            <div
              v-for="tag in tagRows"
              :key="tag"
              class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2"
              @pointerdown="toggle(tag)"
            >
              <Checkbox
                class="flex-shrink-0 pointer-events-none"
                :model-value="has(tag)"
              />
              <span class="flex-grow truncate">
                {{ naturalizeTagName(tag) }}
                <span v-if="translationMap[tag]" class="text-fg-subtle ml-0.5">{{ translationMap[tag] }}</span>
              </span>
              <div
                v-if="countMap[tag] || has(tag)"
                class="font-mono inline-flex flex-shrink-0 tabular-nums"
              >
                <span class="text-right flex-shrink-0 w-10" :class="countMap[tag] ? 'text-fg-muted' : 'text-fg-subtle'">{{ countMap[tag] || 0 }}</span>
                <span v-if="countMap[tag]" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ pct(countMap[tag]) }}%</span>
              </div>
            </div>
            <div
              v-if="tagRows.length === 0"
              class="text-xs text-fg-subtle px-2 py-3 text-center"
            >
              {{ isLoading ? $t('common.loading') : $t('filter.noTagsFound') }}
            </div>
          </div>
        </div>
      </template>
    </Popover>
  </div>
</template>
