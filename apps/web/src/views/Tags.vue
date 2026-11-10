<script setup lang="ts">
import type { TagWithCountPublic } from '@/api'
import type { TagTreeNode } from '@/composables/useTagTree'
import type { PMenuItem } from '@/ui'
import { useDebounce, useElementSize } from '@vueuse/core'
import { computed, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useTagCatalogueQuery } from '@/composables/useTagCatalogueQuery'
import { useTagSearchIndex } from '@/composables/useTagSearchIndex'
import {
  buildTagTree,
  UNCATEGORISED,
  useTagTreeQuery,
  visibleNodes,
} from '@/composables/useTagTree'
import { formatNumber } from '@/locale'
import { announce, postFilter } from '@/shared'
import { naturalizeTagName, tagLabel } from '@/utils/tagName'

/**
 * 一个虚拟滚动项：要么是分类行，要么是一行 tag（分类直属的，或搜索结果）。
 *
 * 虚拟化的粒度必须是「行」。库里有五万多个标签，按分类整块渲染的话展开一个大分类
 * 就要一次性挂上上万个 PostTag —— 这个页面按首字母分组时就是这么卡死的。
 */
type Row
  = | { kind: 'category', node: TagTreeNode, expanded: boolean, preview: TagWithCountPublic[] }
    | { kind: 'tags', path: string, tags: TagWithCountPublic[] }

const CATEGORY_HEIGHT = 34
const TAG_ROW_HEIGHT = 32
/** 每格的最小宽度，用来按容器宽度推列数。 */
const MIN_COLUMN_WIDTH = 200
/** 搜索结果带原名 + 译名，格子要宽一些。 */
const MIN_SEARCH_COLUMN_WIDTH = 260
/** 每层缩进，让子分类和父分类的箭头错开。 */
const INDENT = 16
/** 收起的分类行里预览几个最常用的标签。 */
const PREVIEW_COUNT = 5

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const tagQuery = useTagCatalogueQuery()
const treeQuery = useTagTreeQuery()

const isLoading = computed(() => tagQuery.isLoading.value || treeQuery.isLoading.value)
const loadError = computed(() => tagQuery.error.value ?? treeQuery.error.value)

const tagData = computed(() => tagQuery.data.value ?? [])
const categories = computed(() => treeQuery.data.value ?? [])
const tagsByName = computed(() => new Map(tagData.value.map(tag => [tag.name, tag])))

const tree = computed(() => buildTagTree(
  categories.value,
  tagData.value,
  group => t(`tagsView.group.${group}`),
  t('tagsView.uncategorised'),
))

// ── 搜索（?q= 进 URL：点进画廊再后退，搜索词还在）────────────────────
function queryParam(): string {
  const q = route.query.q
  return typeof q === 'string' ? q : ''
}
const search = ref(queryParam())
// 每敲一个字符都跑一遍五万条的过滤是白干，等手停下来再算一次。
// （和 TagFilter.vue 的标签搜索同一个节奏。）
const debouncedSearch = useDebounce(search, 250)
const query = computed(() => debouncedSearch.value.trim().toLowerCase())

watch(debouncedSearch, (value) => {
  const q = value.trim()
  if (q !== queryParam()) {
    void router.replace({ query: q ? { ...route.query, q } : { ...route.query, q: undefined } })
  }
})
watch(() => route.query.q, () => {
  const q = queryParam()
  if (q !== search.value.trim()) {
    search.value = q
  }
})

function onSearchKeydown(e: KeyboardEvent) {
  // Esc 清空搜索；已经是空的就放行（交给页面 / 图层栈）。
  if (e.key === 'Escape' && !e.isComposing && search.value !== '') {
    e.preventDefault()
    e.stopPropagation()
    search.value = ''
  }
}

const searchIndex = useTagSearchIndex(tagData)

/**
 * 搜索结果：平铺、按相关度排 —— 完全相同 > 前缀 > 包含，同档按图片数。「前缀」也算
 * 词首：搜 hat 时 witch_hat 和 hat_ribbon 同档，不会被几百个只用过两次的 hatsune_*
 * 压到最后。
 * 计数为 0 的标签（库里已经没有图用它）不出现：点进去也是一片空白。
 * 下划线名和自然写法（green eyes）都认。
 */
const searchResults = computed<TagWithCountPublic[] | null>(() => {
  const q = query.value
  if (q === '') {
    return null
  }
  const qUnderscore = q.replaceAll(' ', '_')
  const ranked: { tag: TagWithCountPublic, rank: number }[] = []
  for (const [tag, haystack] of searchIndex.value.entries) {
    if (!tag.count) {
      continue
    }
    if (!haystack.includes(q) && !haystack.includes(qUnderscore)) {
      continue
    }
    const name = tag.name.toLowerCase()
    const translated = tag.translatedName?.toLowerCase() ?? ''
    const rank = name === qUnderscore || translated === q
      ? 0
      : name.startsWith(qUnderscore) || name.includes(`_${qUnderscore}`) || translated.startsWith(q)
        ? 1
        : 2
    ranked.push({ tag, rank })
  }
  ranked.sort((a, b) => a.rank - b.rank || b.tag.count - a.tag.count)
  return ranked.map(r => r.tag)
})

// ── 分类树 ───────────────────────────────────────────────────────────
const scroller = useTemplateRef<{ scrollY: number, scrollToOffset: (top: number) => void }>('scroller')

/** 手动展开的分类。 */
const opened = ref(new Set<string>())
const touched = ref(false)

const expanded = computed(() => {
  if (touched.value) {
    return opened.value
  }
  // 默认展开语义树的顶层，让页面一进来就有内容，而不是一屏光秃秃的标题。合成的那
  // 几个（角色名 / 作品名 / 画师 / 未分类）不展开：那是几万条名字的平铺，没有浏览
  // 价值，要找的人会搜。收起的分类行自带前几个标签的预览（见 previews）。
  return new Set(
    tree.value
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

function collapseAll() {
  opened.value = new Set()
  touched.value = true
  scroller.value?.scrollToOffset(0)
}

/** 每个分类整棵子树里最常用的几个标签：收起时在分类行里预览，不点开也知道里面是什么。 */
const previews = computed(() => {
  const nodes = tree.value
  const byPath = new Map<string, TagWithCountPublic[]>()
  const top = (list: TagWithCountPublic[]) => list.toSorted((a, b) => b.count - a.count).slice(0, PREVIEW_COUNT)
  // 前序排列（父在子前）：倒着走，子树的预览先算好再并进父节点。
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    byPath.set(node.path, top([...node.own.slice(0, PREVIEW_COUNT), ...(byPath.get(node.path) ?? [])]))
    if (node.parent) {
      byPath.set(node.parent, top([...(byPath.get(node.parent) ?? []), ...byPath.get(node.path)!]))
    }
  }
  return byPath
})

const listRef = ref<HTMLElement | null>(null)
const { width: listWidth } = useElementSize(listRef)

function perRow(usable: number, min: number) {
  return Math.max(1, Math.floor(usable / min))
}

const rows = computed<Row[]>(() => {
  const result: Row[] = []
  const hits = searchResults.value
  if (hits) {
    const n = perRow(listWidth.value - 32, MIN_SEARCH_COLUMN_WIDTH)
    for (let i = 0; i < hits.length; i += n) {
      result.push({ kind: 'tags', path: '', tags: hits.slice(i, i + n) })
    }
    return result
  }
  for (const node of visibleNodes(tree.value, expanded.value)) {
    const isOpen = expanded.value.has(node.path)
    result.push({ kind: 'category', node, expanded: isOpen, preview: isOpen ? [] : previews.value.get(node.path) ?? [] })
    if (!isOpen || node.own.length === 0) {
      continue
    }
    // tag 行跟着分类缩进，可用宽度随之变窄，列数也要跟着算。
    const n = perRow(listWidth.value - 32 - (node.depth + 1) * INDENT, MIN_COLUMN_WIDTH)
    for (let i = 0; i < node.own.length; i += n) {
      result.push({ kind: 'tags', path: node.path, tags: node.own.slice(i, i + n) })
    }
  }
  return result
})

function rowHeight(row: Row) {
  return row.kind === 'category' ? CATEGORY_HEIGHT : TAG_ROW_HEIGHT
}

function indentOf(row: Row) {
  if (row.kind === 'category') {
    return row.node.depth * INDENT
  }
  return row.path ? row.path.split('.').length * INDENT : 0
}

// ── 粘顶的分类头 ─────────────────────────────────────────────────────
// 展开一个大分类后往下翻几屏，就不知道自己在哪个分类里了。当前所在的顶层分类头
// 钉在列表顶上；点它收起这个分类并回到它的位置。
const rowOffsets = computed(() => {
  const offsets: number[] = []
  let y = 0
  for (const row of rows.value) {
    offsets.push(y)
    y += rowHeight(row)
  }
  return offsets
})
const stickyIndex = computed(() => {
  const y = scroller.value?.scrollY ?? 0
  if (searchResults.value || y <= 0) {
    return -1
  }
  let found = -1
  for (const [i, row] of rows.value.entries()) {
    if (rowOffsets.value[i] > y) {
      break
    }
    if (row.kind === 'category' && row.node.depth === 0) {
      found = i
    }
  }
  // 头本身还在视口里时不用再钉一份；收起的分类下面没有内容可迷路。
  const row = rows.value[found]
  return row?.kind === 'category' && row.expanded && rowOffsets.value[found] < y ? found : -1
})
const stickyRow = computed(() => {
  const row = rows.value[stickyIndex.value]
  return row?.kind === 'category' ? row : null
})
function collapseSticky() {
  const row = stickyRow.value
  if (!row) {
    return
  }
  const top = rowOffsets.value[stickyIndex.value]
  toggle(row.node.path)
  scroller.value?.scrollToOffset(top)
}

// ── 标签：点击看图，右键 / Shift+F10 菜单 ────────────────────────────
function filterByTag(name: string, only: boolean) {
  const current = postFilter.value.tags
  postFilter.value.tags = only ? [name] : current.includes(name) ? current : [...current, name]
  void router.push('/')
}

const activeTag = ref<TagWithCountPublic | null>(null)
function tagFromEvent(e: Event): TagWithCountPublic | null {
  const el = (e.target as Element | null)?.closest<HTMLElement>('[data-tag-name]')
  return el ? tagsByName.value.get(el.dataset.tagName!) ?? null : null
}
// 菜单只为标签开：右键 / 键盘菜单键落在别处（分类行、空白）时不拦，交还给浏览器。
function onListContextMenu(e: MouseEvent) {
  activeTag.value = tagFromEvent(e)
  if (!activeTag.value) {
    e.stopPropagation()
  }
}
function onListKeydown(e: KeyboardEvent) {
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    activeTag.value = tagFromEvent(e)
    if (!activeTag.value) {
      e.stopPropagation()
    }
  }
}

const tagMenuData = computed<PMenuItem[]>(() => {
  const tag = activeTag.value
  if (!tag) {
    return []
  }
  return [
    { role: 'label', title: tag.translatedName ?? naturalizeTagName(tag.name) },
    { title: t('post.panel.tagFilter'), icon: 'i-tabler-filter-plus', value: 'filter' },
    { title: t('post.panel.tagFilterOnly'), icon: 'i-tabler-filter', value: 'filterOnly' },
    { role: 'divider' },
    { title: t('tagsView.copyName'), icon: 'i-tabler-copy', value: 'copy' },
  ]
})

async function onTagMenuSelect(value: string | number | symbol) {
  const tag = activeTag.value
  if (!tag) {
    return
  }
  switch (value) {
    case 'filter': {
      filterByTag(tag.name, false)
      break
    }
    case 'filterOnly': {
      filterByTag(tag.name, true)
      break
    }
    case 'copy': {
      try {
        await navigator.clipboard.writeText(tag.name)
        announce(t('tagsView.nameCopied', { name: tag.name }))
      }
      catch {
        announce(t('post.panel.copyFailed'), 'assertive')
      }
      break
    }
  }
}

function tagTitle(tag: TagWithCountPublic) {
  return t('tagsView.tagTitle', { name: tag.name, n: formatNumber(tag.count) })
}
</script>

<template>
  <div class="flex flex-col h-full">
    <h1 class="sr-only">
      {{ $t('tagsView.title') }}
    </h1>
    <div class="px-4 py-3 border-b border-border-default bg-bg/85 flex gap-3 items-center top-0 sticky z-10 backdrop-blur">
      <PInput
        v-model="search"
        variant="plain"
        :placeholder="$t('tagsView.searchPlaceholder')"
        :aria-label="$t('tagsView.searchAria')"
        block
        @keydown="onSearchKeydown"
      >
        <template #leftSection>
          <i class="i-tabler-search text-fg-muted" aria-hidden="true" />
        </template>
      </PInput>
      <span v-if="searchResults" role="status" class="text-xs text-fg-muted shrink-0 tabular-nums">
        {{ $t('tagsView.resultCount', { n: formatNumber(searchResults.length) }, searchResults.length) }}
      </span>
      <PButton
        v-else-if="!isLoading && !loadError"
        size="sm"
        variant="ghost"
        class="shrink-0"
        @click="collapseAll"
      >
        <i class="i-tabler-fold" aria-hidden="true" />
        {{ $t('tagsView.collapseAll') }}
      </PButton>
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
      role="status"
      icon="i-tabler-mood-empty"
      class="p-16"
    >
      {{ $t('tagsView.noMatch', { search: debouncedSearch.trim() }) }}
    </PEmpty>
    <div
      v-else
      ref="listRef"
      class="flex-1 min-h-0 relative overflow-hidden"
      @contextmenu.capture="onListContextMenu"
      @keydown.capture="onListKeydown"
    >
      <PMenu
        class="h-full"
        :data="tagMenuData"
        trigger="contextmenu"
        :aria-label="activeTag ? $t('post.panel.tagMenu', { tag: activeTag.name }) : undefined"
        @select="onTagMenuSelect"
      >
        <PVirtualScroll
          ref="scroller"
          :items="rows"
          :item-height="rowHeight"
          class="h-full"
        >
          <template #default="{ item: row }">
            <div :style="{ height: `${rowHeight(row)}px`, paddingLeft: `${16 + indentOf(row)}px` }">
              <div
                v-if="row.kind === 'category'"
                class="pr-4 flex gap-3 h-full min-w-0 items-center"
              >
                <button
                  type="button"
                  class="tag-category flex shrink-0 gap-1.5 h-full items-center"
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
                <!-- 收起时预览子树里最常用的几个标签（点它们直接看图）。 -->
                <div v-if="row.preview.length > 0" class="flex gap-1.5 min-w-0 items-center overflow-hidden">
                  <button
                    v-for="tag of row.preview"
                    :key="tag.name"
                    type="button"
                    class="tag-cell op-70 shrink-0"
                    :data-tag-name="tag.name"
                    :title="tagTitle(tag)"
                    @click="filterByTag(tag.name, true)"
                  >
                    <PostTag :data="tag" />
                  </button>
                </div>
              </div>
              <div
                v-else
                class="pr-4 gap-x-3 grid h-full items-center"
                :style="{ gridTemplateColumns: `repeat(${row.tags.length}, minmax(0, 1fr))` }"
              >
                <button
                  v-for="tag of row.tags"
                  :key="tag.name"
                  type="button"
                  class="tag-cell flex gap-1.5 min-w-0 items-center"
                  :data-tag-name="tag.name"
                  :title="tagTitle(tag)"
                  @click="filterByTag(tag.name, true)"
                >
                  <span
                    v-if="searchResults"
                    v-highlight="debouncedSearch.trim()"
                    class="text-sm text-fg min-w-0 truncate"
                    :style="tag.group?.color ? { color: `color-mix(in oklab, ${tag.group.color} 60%, var(--p-fg) 40%)` } : undefined"
                  >{{ tagLabel(tag.name, tag.translatedName) }}</span>
                  <PostTag v-else class="min-w-0" :data="tag" />
                  <span class="text-xs text-fg-subtle shrink-0 tabular-nums">
                    {{ formatNumber(tag.count) }}
                  </span>
                </button>
              </div>
            </div>
          </template>
        </PVirtualScroll>
      </PMenu>
      <button
        v-if="stickyRow"
        type="button"
        class="tag-category tag-sticky text-base font-semibold pl-4 pr-4 flex gap-1.5 w-full items-center left-0 top-0 absolute"
        :style="{ height: `${CATEGORY_HEIGHT}px` }"
        :aria-expanded="true"
        :title="$t('tagsView.collapseHere')"
        @click="collapseSticky"
      >
        <i class="i-tabler-chevron-down text-fg-subtle shrink-0" aria-hidden="true" />
        <span class="truncate">{{ stickyRow.node.name }}</span>
        <span class="text-xs text-fg-subtle font-normal shrink-0 tabular-nums">
          {{ formatNumber(stickyRow.node.total) }}
        </span>
      </button>
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
.tag-sticky {
  z-index: 2;
  background: var(--p-bg);
  border-bottom: 1px solid var(--p-border);
}
.tag-cell {
  background: transparent;
  border: 0;
  padding: 0;
  border-radius: var(--p-radius-sm);
  cursor: pointer;
  text-align: left;
}
.tag-cell:hover {
  opacity: 1;
}
.tag-cell:hover :deep(.post-tag),
.tag-cell:hover > span:first-child {
  text-decoration: underline;
}
</style>
