<script setup lang="ts">
import type { TagCountRequest } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { useDebounce } from '@vueuse/core'
import { computed, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetPostsCount, v2GetTagCount } from '@/api'
import { activateOptionOnKey, facetOptionLabel, facetTriggerLabel, formatPct, gatedCountOptions, useFacetListbox } from '@/composables/useFacetFilter'
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

// Only run the count queries while the dropdown is actually open — the same
// `opened` gate every facet uses (shared options from useFacetFilter's
// `gatedCountOptions`); bind it to the PPopover's v-model below.
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
  ...gatedCountOptions(opened),
})

// Denominator for the per-tag percentage: the number of posts matching the
// current filter (tags facet cleared). Tags aren't mutually exclusive, so —
// unlike the other facets — the counts don't sum to the post total; dividing by
// it makes the '%' read as "share of these posts that carry this tag".
const postTotalQuery = useQuery({
  queryKey: computed(() => queryKeys.tagsTotalCount(filterWithoutSelf.value)),
  queryFn: async () => {
    const resp = await v2GetPostsCount({ body: filterWithoutSelf.value })
    return resp.data?.count ?? 0
  },
  ...gatedCountOptions(opened),
})

const countMap = computed(() => {
  const map: Record<string, number> = {}
  for (const d of countQuery.data.value ?? []) {
    map[d.tagName] = d.count
  }
  return map
})

// 本地化显示名（来自 count 响应）；搜索/筛选仍以原始下划线名为准。
const translationMap = computed(() => {
  const map: Record<string, string> = {}
  for (const d of countQuery.data.value ?? []) {
    if (d.translatedName) {
      map[d.tagName] = d.translatedName
    }
  }
  return map
})
const total = computed(() => postTotalQuery.data.value ?? 0)
function pct(count: number): string {
  return formatPct(count, total.value)
}

// Pin selected tags at the top so they stay un-checkable even when they fall
// outside the current top-N / search results.
const tagRows = computed(() => {
  const fromApi = (countQuery.data.value ?? []).map(d => d.tagName)
  return [...new Set([...selected.value, ...fromApi])]
})

const isLoading = computed(() => countQuery.isLoading.value)
const btnText = computed(() => (selected.value.length === 0 ? t('filter.tags') : selected.value.map(naturalizeTagName).join(', ')))
const triggerLabel = computed(() => facetTriggerLabel(t, t('filter.tags'), selected.value.map(naturalizeTagName)))

function tagDisplayName(tag: string): string {
  const translated = translationMap.value[tag]
  return translated ? `${naturalizeTagName(tag)} ${translated}` : naturalizeTagName(tag)
}
function optionLabel(tag: string): string {
  return facetOptionLabel(t, tagDisplayName(tag), countQuery.data.value ? (countMap.value[tag] ?? 0) : undefined)
}

// Keyboard model: the search box takes initial focus; ArrowDown enters the
// listbox, ArrowUp on the first option returns to the box. Inside the list,
// typing is not typeahead (the tags are open-ended) — it goes on into the
// search box, the same as a combobox, so "search → pick → refine" never
// needs the mouse. Space / Enter toggle the focused tag.
const listboxId = useId()
const listbox = useTemplateRef<HTMLElement>('listbox')
const searchBox = useTemplateRef<HTMLElement>('searchBox')
const roving = useFacetListbox(listbox, { typeahead: false, loop: false })

function focusSearch() {
  searchBox.value?.querySelector<HTMLInputElement>('input')?.focus()
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
    return
  }
  if (e.key === 'ArrowDown' && tagRows.value.length > 0) {
    e.preventDefault()
    roving.focusFirst()
  }
}

function onOptionKeydown(e: KeyboardEvent, tag: string, index: number) {
  if (activateOptionOnKey(e, () => toggle(tag))) {
    return
  }
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) {
    return
  }
  if (e.key === 'ArrowUp' && index === 0 && !e.shiftKey) {
    e.preventDefault()
    focusSearch()
  }
  else if (e.key === 'Backspace') {
    e.preventDefault()
    search.value = search.value.slice(0, -1)
    focusSearch()
  }
  else if ([...e.key].length === 1) {
    // Printable character: continue the query in the search box. Consumed
    // here (not left to bubble) so no global letter hotkey sees it.
    e.preventDefault()
    search.value += e.key
    focusSearch()
  }
}
</script>

<template>
  <div class="relative">
    <PPopover
      v-model="opened"
      position="bottom-start"
    >
      <PButton
        size="sm"
        :variant="selected.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <i class="i-tabler-tag" aria-hidden="true" />
        <!-- leading-normal: the button sets line-height:1, and `truncate`
             (overflow:hidden) would otherwise clip glyph descenders (e.g. "g"). -->
        <span class="leading-normal flex-grow max-w-40 truncate">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <div class="p-popover-panel min-w-64">
          <div ref="searchBox" class="mb-2">
            <PInput
              v-model="search"
              size="sm"
              :placeholder="$t('filter.searchTagsPlaceholder')"
              :aria-label="$t('filter.searchTags')"
              :aria-controls="listboxId"
              block
              data-autofocus="true"
              @keydown="onSearchKeydown"
            >
              <template #leftSection>
                <i class="i-tabler-search text-fg-muted" aria-hidden="true" />
              </template>
            </PInput>
          </div>
          <div class="max-h-72 overflow-y-auto">
            <div
              :id="listboxId"
              ref="listbox"
              role="listbox"
              aria-multiselectable="true"
              :aria-label="$t('filter.tags')"
              :aria-busy="isLoading || undefined"
            >
              <div
                v-for="(tag, i) in tagRows"
                :key="tag"
                role="option"
                :aria-selected="has(tag)"
                :aria-label="optionLabel(tag)"
                class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2 focus-visible:[outline-offset:-2px]"
                @click="toggle(tag)"
                @keydown="onOptionKeydown($event, tag, i)"
              >
                <PCheckbox
                  class="flex-shrink-0 pointer-events-none"
                  :model-value="has(tag)"
                  inert
                  aria-hidden="true"
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
            </div>
            <div
              v-if="tagRows.length === 0 && isLoading"
              class="text-xs text-fg-subtle px-2 py-3 text-center"
            >
              {{ $t('common.loading') }}
            </div>
            <PEmpty
              v-else-if="tagRows.length === 0"
              icon="i-tabler-tag-off"
              class="py-4"
            >
              {{ $t('filter.noTagsFound') }}
            </PEmpty>
          </div>
        </div>
      </template>
    </PPopover>
  </div>
</template>
