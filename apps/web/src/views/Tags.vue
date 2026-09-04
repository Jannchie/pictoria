<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { useDebounce, useElementSize } from '@vueuse/core'
import { computed, ref, toRaw } from 'vue'
import { v2ListTags } from '@/api'
import { resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

/**
 * 一个虚拟滚动项：要么是首字母标题，要么是一整行标签。
 *
 * 之前虚拟化的粒度是「首字母分组」，于是 `s` 组一进视口就要一次性挂上近万个
 * PostTag —— 库里有五万多个标签，打开这个页面就是几秒白屏加持续掉帧。改成按
 * 行切之后单项恒定是一行，视口里始终只有几十个组件。
 */
type Row
  = | { kind: 'header', letter: string, count: number }
  | { kind: 'tags', tags: TagWithCountPublic[] }

const HEADER_HEIGHT = 56
const TAG_ROW_HEIGHT = 32
/** 每格的最小宽度，用来按容器宽度推列数。 */
const MIN_COLUMN_WIDTH = 200

const tagQuery = useQuery({
  // Locale lives in the key (folded into queryKeys.tags) so a language switch
  // refetches the server-side translated names. invalidateQueries(
  // queryKeys.tagsRoot) still matches by prefix.
  queryKey: queryKeys.tags(),
  queryFn: async () => {
    const resp = await v2ListTags({ query: { lang: resolvedLocale.value } })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  // 五万多行的结构化共享（逐字段深比较后复用旧引用）比响应本身的解析还贵，
  // 而这里每次拿到的都是全新数组，比较不出任何可复用的东西。
  structuralSharing: false,
})

const search = ref('')
// 每敲一个字符都跑一遍五万条的过滤 + 分组是白干,等手停下来再算一次。
// （和 TagFilter.vue 的标签搜索同一个节奏。）
const debouncedSearch = useDebounce(search, 250)

/**
 * 已按 count 降序排好的全表。
 *
 * `toRaw` 是要点：vue-query 会把结果深层 `reactive()` 一遍,而下面每一趟都要走
 * 五万个元素,带着代理走每次属性读取都是一次 WeakMap 查找。这里只读不写,拿原始
 * 数组即可。
 *
 * 排序放在过滤之前：过滤不会改变相对顺序,所以按 count 排一次就够,不必每次搜索
 * 都对每个分组重排。
 */
const tagData = computed(() => {
  const rows = toRaw(tagQuery.data.value) ?? []
  return [...rows].sort((a, b) => b.count - a.count)
})

/**
 * 与 `tagData` 同序的小写检索串（原始下划线名 + 本地化显示名）。
 *
 * 每敲一个字符都对五万条各做两次 `toLowerCase` 是纯重复劳动 —— 预先算一遍，
 * 之后每次过滤只剩 `includes`。
 */
const searchIndex = computed(() => tagData.value.map(d => `${d.name} ${d.translatedName ?? ''}`.toLowerCase()))

const tagDataSearched = computed(() => {
  // 原始下划线名或本地化显示名命中皆可,中文输入也能搜到 tag。
  const q = debouncedSearch.value.trim().toLowerCase()
  if (q === '') {
    return tagData.value
  }
  const index = searchIndex.value
  return tagData.value.filter((_, i) => index[i].includes(q))
})

const tagGroupByFirstChar = computed(() => {
  // Map 而不是 findIndex：分组有三十多个,线性查找会把 O(n) 变成 O(n×组数)。
  const groups = new Map<string, TagWithCountPublic[]>()
  for (const d of tagDataSearched.value) {
    if (d.name.length === 0) {
      continue
    }
    const firstChar = d.name[0].toUpperCase()
    const bucket = groups.get(firstChar)
    if (bucket) {
      bucket.push(d)
    }
    else {
      groups.set(firstChar, [d])
    }
  }

  // 组内顺序继承自 tagData 的 count 降序,不用再排。
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})

const listRef = ref<HTMLElement | null>(null)
const { width: listWidth } = useElementSize(listRef)
const columns = computed(() => {
  // 容器左右各 1rem 内边距。
  const usable = listWidth.value - 32
  return Math.max(1, Math.floor(usable / MIN_COLUMN_WIDTH))
})

const rows = computed<Row[]>(() => {
  const perRow = columns.value
  const result: Row[] = []
  for (const [letter, tags] of tagGroupByFirstChar.value) {
    result.push({ kind: 'header', letter, count: tags.length })
    for (let i = 0; i < tags.length; i += perRow) {
      result.push({ kind: 'tags', tags: tags.slice(i, i + perRow) })
    }
  }
  return result
})

function rowHeight(row: Row | undefined) {
  return row?.kind === 'header' ? HEADER_HEIGHT : TAG_ROW_HEIGHT
}
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
    <PEmpty
      v-else-if="rows.length === 0"
      icon="i-tabler-mood-empty"
      class="p-16"
    >
      {{ $t('tagsView.noMatch', { search }) }}
    </PEmpty>
    <div v-else ref="listRef" class="flex-1 overflow-hidden">
      <PVirtualScroll
        :items="rows"
        :item-height="rowHeight"
        class="h-full"
      >
        <template #default="{ item: row }">
          <div :style="{ height: `${rowHeight(row)}px` }">
            <div
              v-if="row.kind === 'header'"
              class="px-4 pb-2 flex gap-2 h-full items-end"
            >
              <h2 class="text-2xl tracking-tight font-semibold">
                {{ row.letter }}
              </h2>
              <span class="text-sm text-fg-subtle tabular-nums">
                {{ row.count }}
              </span>
            </div>
            <div
              v-else
              class="px-4 gap-x-3 grid h-full items-center"
              :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }"
            >
              <div
                v-for="tag of row.tags"
                :key="tag.name"
                class="flex gap-1.5 min-w-0 items-center"
              >
                <PostTag
                  class="min-w-0 cursor-pointer"
                  :data="tag"
                />
                <span class="text-xs text-fg-subtle shrink-0 tabular-nums">
                  {{ tag.count }}
                </span>
              </div>
            </div>
          </div>
        </template>
      </PVirtualScroll>
    </div>
  </div>
</template>
