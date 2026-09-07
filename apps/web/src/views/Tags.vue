<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import type { TagTreeNode } from '@/composables/useTagTree'
import { useQuery } from '@tanstack/vue-query'
import { useDebounce, useElementSize } from '@vueuse/core'
import { computed, ref, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2ListTags } from '@/api'
import {
  buildTagTree,
  filterTagTree,
  UNCATEGORISED,
  useTagTreeQuery,
  visibleNodes,
} from '@/composables/useTagTree'
import { formatNumber, resolvedLocale } from '@/locale'
import { queryKeys } from '@/shared/queryKeys'

/**
 * 一个虚拟滚动项：要么是分类行，要么是该分类直属 tag 的一行。
 *
 * 虚拟化的粒度必须是「行」。库里有五万多个标签，按分类整块渲染的话展开一个大分类
 * 就要一次性挂上上万个 PostTag —— 这个页面按首字母分组时就是这么卡死的。
 */
type Row
  = | { kind: 'category', node: TagTreeNode, expanded: boolean }
  | { kind: 'tags', path: string, offset: number, tags: TagWithCountPublic[] }

const CATEGORY_HEIGHT = 34
const TAG_ROW_HEIGHT = 32
/** 每格的最小宽度，用来按容器宽度推列数。 */
const MIN_COLUMN_WIDTH = 200
/** 每层缩进，让子分类和父分类的箭头错开。 */
const INDENT = 16

const { t } = useI18n()

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
const treeQuery = useTagTreeQuery()

const isLoading = computed(() => tagQuery.isLoading.value || treeQuery.isLoading.value)
const loadError = computed(() => tagQuery.error.value ?? treeQuery.error.value)

/**
 * `toRaw` 是要点：vue-query 会把结果深层 `reactive()` 一遍，而下面每一趟都要走
 * 五万个元素，带着代理走每次属性读取都是一次 WeakMap 查找。这里只读不写。
 */
const tagData = computed(() => toRaw(tagQuery.data.value) ?? [])
const categories = computed(() => toRaw(treeQuery.data.value) ?? [])

const tree = computed(() => buildTagTree(
  categories.value,
  tagData.value,
  group => t(`tagsView.group.${group}`),
  t('tagsView.uncategorised'),
))

const search = ref('')
// 每敲一个字符都跑一遍五万条的过滤是白干,等手停下来再算一次。
// （和 TagFilter.vue 的标签搜索同一个节奏。）
const debouncedSearch = useDebounce(search, 250)
const query = computed(() => debouncedSearch.value.trim().toLowerCase())

/** 命中搜索的 tag 名；无搜索词时为 null（表示"全都要"，而不是"一个都没有"）。 */
const matched = computed(() => {
  const q = query.value
  if (q === '') {
    return null
  }
  const hit = new Set<string>()
  for (const tag of tagData.value) {
    // 原始下划线名或本地化显示名命中皆可,中文输入也能搜到 tag。
    if (tag.name.toLowerCase().includes(q) || tag.translatedName?.toLowerCase().includes(q)) {
      hit.add(tag.name)
    }
  }
  return hit
})

const shownTree = computed(() => {
  const hit = matched.value
  return hit === null ? tree.value : filterTagTree(tree.value, tag => hit.has(tag.name))
})

/** 手动展开的分类。 */
const opened = ref(new Set<string>())
const touched = ref(false)

const expanded = computed(() => {
  // 搜索时把幸存的分类全部展开 —— 它们已经被过滤成"含命中 tag"的那些了，再折叠起来
  // 就是搜了等于没搜。只展开祖先链不够：叶子自己不展开，命中的 tag 一个也看不见。
  if (matched.value !== null) {
    return new Set(shownTree.value.map(n => n.path))
  }
  if (touched.value) {
    return opened.value
  }
  // 默认展开语义树的顶层，让页面一进来就有内容，而不是一屏光秃秃的标题。合成的那
  // 几个（角色名 / 作品名 / 画师 / 未分类）不展开：那是几万条名字的平铺，没有浏览
  // 价值，要找的人会搜。
  return new Set(
    shownTree.value
      .filter(n => n.depth === 0 && !n.path.startsWith(UNCATEGORISED))
      .map(n => n.path),
  )
})

function toggle(path: string) {
  const next = new Set(expanded.value)
  if (next.has(path)) {
    next.delete(path)
  }
  else {
    next.add(path)
  }
  opened.value = next
  touched.value = true
}

const listRef = ref<HTMLElement | null>(null)
const { width: listWidth } = useElementSize(listRef)

const rows = computed<Row[]>(() => {
  const result: Row[] = []
  for (const node of visibleNodes(shownTree.value, expanded.value)) {
    const isOpen = expanded.value.has(node.path)
    result.push({ kind: 'category', node, expanded: isOpen })
    if (!isOpen || node.own.length === 0) {
      continue
    }
    // tag 行跟着分类缩进，可用宽度随之变窄，列数也要跟着算。
    const usable = listWidth.value - 32 - (node.depth + 1) * INDENT
    const perRow = Math.max(1, Math.floor(usable / MIN_COLUMN_WIDTH))
    for (let i = 0; i < node.own.length; i += perRow) {
      result.push({
        kind: 'tags',
        path: node.path,
        offset: i,
        tags: node.own.slice(i, i + perRow),
      })
    }
  }
  return result
})

function rowHeight(row: Row) {
  return row.kind === 'category' ? CATEGORY_HEIGHT : TAG_ROW_HEIGHT
}

function indentOf(row: Row) {
  return row.kind === 'category'
    ? row.node.depth * INDENT
    : (row.path.split('.').length) * INDENT
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="px-4 py-3 border-b border-border-default bg-bg/85 top-0 sticky z-10 backdrop-blur">
      <PInput
        v-model="search"
        variant="plain"
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
      v-if="isLoading"
      role="status"
      class="p-16 text-center op-50 flex flex-col gap-2 items-center"
    >
      <i class="i-tabler-loader text-2xl animate-spin" aria-hidden="true" />
      <div class="text-sm">
        {{ $t('tagsView.loading') }}
      </div>
    </div>
    <div
      v-else-if="loadError"
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
          <div :style="{ height: `${rowHeight(row)}px`, paddingLeft: `${16 + indentOf(row)}px` }">
            <button
              v-if="row.kind === 'category'"
              type="button"
              class="tag-category pr-4 flex gap-1.5 h-full w-full items-center"
              :aria-expanded="row.expanded"
              @click="toggle(row.node.path)"
            >
              <i
                class="text-fg-subtle shrink-0"
                :class="row.expanded ? 'i-tabler-chevron-down' : 'i-tabler-chevron-right'"
                aria-hidden="true"
              />
              <span
                class="truncate"
                :class="row.node.depth === 0 ? 'text-base font-semibold' : 'text-sm'"
              >
                {{ row.node.name }}
              </span>
              <span class="text-xs text-fg-subtle shrink-0 tabular-nums">
                {{ formatNumber(row.node.total) }}
              </span>
            </button>
            <div
              v-else
              class="pr-4 gap-x-3 grid h-full items-center"
              :style="{ gridTemplateColumns: `repeat(${row.tags.length}, minmax(0, 1fr))` }"
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

<style scoped>
.tag-category {
  background: transparent;
  border: 0;
  padding-block: 0;
  color: var(--p-fg);
  cursor: pointer;
  text-align: left;
}
.tag-category:hover {
  color: var(--p-primary);
}
</style>
