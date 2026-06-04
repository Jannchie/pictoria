<script setup lang="ts">
import type { TreeListCollapseData, TreeListItemData, TreeListLeafData } from './components/TreeList.vue'
import type { DirectorySummary } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { Pane, Splitpanes } from 'splitpanes'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { formatNumber } from '@/locale'
import FolderStatsLine from './components/FolderStatsLine.vue'
import TreeList from './components/TreeList.vue'
import { useGlobalUndoRedo, useWatchRoute } from './composables'
import { deleteFolder, focusedTreeFolder, isAnyDialogOpen, menuData, showMenu, useCurrentFolder, useFoldersQuery, useSyncFilterWithUrl } from './shared'
import 'splitpanes/dist/splitpanes.css'

const { t } = useI18n()

useWatchRoute()
useGlobalUndoRedo()
// Lives here (not in FilterRow) so the filter↔URL watchers survive route
// changes — re-projecting the filters onto the URL after a navigation only
// works if the watcher is still alive when the path changes.
useSyncFilterWithUrl()

const currentFolder = useCurrentFolder()
const router = useRouter()
const route = useRoute()
const foldersQuery = useFoldersQuery()

const folderFilter = ref('')

type FolderSortKey = 'name' | 'count' | 'silva' | 'score' | 'rating'
// Persisted to localStorage so the chosen folder-tree sort survives reloads.
const folderSortKey = useLocalStorage<FolderSortKey>('pictoria.folderSort.key', 'name')
const folderSortOrder = useLocalStorage<'asc' | 'desc'>('pictoria.folderSort.order', 'asc')
const folderSortShow = ref(false)
// Labels stored as message keys (not resolved strings) so a locale switch
// re-renders them without rebuilding the arrays.
const sortOptions: { key: FolderSortKey, labelKey: string, icon: string }[] = [
  { key: 'name', labelKey: 'sidebar.sortName', icon: 'i-tabler-abc' },
  { key: 'count', labelKey: 'sidebar.sortCount', icon: 'i-tabler-files' },
  { key: 'silva', labelKey: 'sidebar.sortSilva', icon: 'i-tabler-rosette' },
  { key: 'score', labelKey: 'sidebar.sortScore', icon: 'i-tabler-star' },
  { key: 'rating', labelKey: 'sidebar.sortRating', icon: 'i-tabler-thumb-up' },
]
const orderOptions: { id: 'asc' | 'desc', labelKey: string, icon: string }[] = [
  { id: 'asc', labelKey: 'sidebar.ascending', icon: 'i-tabler-arrow-up' },
  { id: 'desc', labelKey: 'sidebar.descending', icon: 'i-tabler-arrow-down' },
]
const sortKeyLabel = computed(() => t(sortOptions.find(o => o.key === folderSortKey.value)?.labelKey ?? 'sidebar.sortName'))

// Recursively sort a directory's children by the chosen key/order. Missing
// score averages sort as -1 so unscored folders sink to the bottom in desc.
function sortNodes(nodes: DirectorySummary[]): DirectorySummary[] {
  const dir = folderSortOrder.value === 'asc' ? 1 : -1
  const key = folderSortKey.value
  const valueOf = (d: DirectorySummary): number | string => {
    switch (key) {
      case 'name': { return d.name ?? ''
      }
      case 'count': { return d.file_count ?? 0
      }
      case 'silva': { return d.silva_avg ?? -1
      }
      case 'score': { return d.score_avg ?? -1
      }
      case 'rating': { return d.rating_avg ?? -1
      }
      default: { return ''
      }
    }
  }
  return [...nodes].sort((a, b) => {
    const va = valueOf(a)
    const vb = valueOf(b)
    if (typeof va === 'string' && typeof vb === 'string') {
      return dir * va.localeCompare(vb)
    }
    return dir * ((va as number) - (vb as number))
  })
}

// Carried on each tree item's `meta` so the row slots can render the
// second line (recursive per-directory SILVA / Score / Rating / coverage).
function statsOf(d: DirectorySummary) {
  return {
    silvaAvg: d.silva_avg,
    scoreAvg: d.score_avg,
    ratingAvg: d.rating_avg,
    scoredRatio: d.scored_ratio,
    postCount: d.post_count ?? 0,
  }
}

// Virtual-list row heights — MUST match what the row slots render, or rows
// overlap / jump. Folders with a stats line (postCount > 0) are taller.
function treeItemHeight(item: TreeListItemData): number {
  if (!('value' in item) && !('children' in item)) {
    return 28 // header
  }
  return (item as TreeListLeafData).meta?.postCount ? 48 : 32
}

function convertPathToTree(path: DirectorySummary): TreeListItemData[] {
  const children = sortNodes(path.children ?? [])
  return children.map((child): TreeListItemData => {
    const base = {
      title: child.name,
      value: child.path,
      count: child.file_count,
      meta: statsOf(child),
    }
    if ((child.children?.length ?? 0) > 0) {
      return { ...base, children: convertPathToTree(child) }
    }
    return base
  })
}

const folderTree = computed<TreeListItemData[]>(() => {
  const root = foldersQuery.data.value
  if (!root) {
    return []
  }
  return [
    {
      title: t('sidebar.root'),
      value: '@',
      count: root.file_count,
      meta: statsOf(root),
    },
    ...convertPathToTree(root),
  ]
})

const highlightChain = computed(() => {
  const path = currentFolder.value
  if (!path || path === '@') {
    return []
  }
  const segments = path.split('/').filter(Boolean)
  const chain: string[] = []
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    chain.push(acc)
  }
  return chain
})

const openPaths = ref(new Set<string>())

watch(currentFolder, (path) => {
  if (!path) {
    return
  }
  const segments = path.split('/').filter(Boolean)
  const next = new Set(openPaths.value)
  let acc = ''
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg
    next.add(acc)
  }
  if (next.size !== openPaths.value.size) {
    openPaths.value = next
  }
}, { immediate: true })

const contextTarget = ref<TreeListLeafData | TreeListCollapseData | null>(null)
function onItemContext({ data }: { data: TreeListLeafData | TreeListCollapseData, event: MouseEvent }) {
  contextTarget.value = data
  menuData.value = data
}
function closeMenu() {
  menuData.value = null
}
async function revealInExplorer() {
  closeMenu()
}
async function copyPath() {
  if (!contextTarget.value?.value) {
    return
  }
  await navigator.clipboard.writeText(contextTarget.value.value).catch(() => {})
  closeMenu()
}
function openFolder() {
  if (!contextTarget.value?.value) {
    return
  }
  router.push({ path: `/dir/${contextTarget.value.value}`, query: route.query })
  closeMenu()
}

// ── 删除目录（树行获得焦点时按 Delete，或右键菜单） ──────────────────────
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
const pendingDeleteFolder = ref<{ path: string, title: string, postCount: number } | null>(null)
const isDeletingFolder = ref(false)

function findFolderNode(items: TreeListItemData[], path: string): TreeListItemData | null {
  for (const item of items) {
    if ('value' in item && item.value === path) {
      return item
    }
    if ('children' in item && item.children) {
      const hit = findFolderNode(item.children, path)
      if (hit) {
        return hit
      }
    }
  }
  return null
}

function requestDeleteFolder(path: string | null | undefined) {
  if (!path || path === '@') {
    return // 根目录不可删
  }
  const node = findFolderNode(folderTree.value, path)
  pendingDeleteFolder.value = {
    path,
    title: node?.title ?? path,
    postCount: (node as TreeListLeafData | null)?.meta?.postCount ?? 0,
  }
}

function onMenuDeleteFolder() {
  const path = contextTarget.value?.value
  closeMenu()
  requestDeleteFolder(path)
}

// 点击树行会聚焦它的 RouterLink（data-tree-value）；此时 Delete 针对该目录，
// 画廊的"删除选中图片"热键经 canHandleGridKeys 让位（见 shared/state.ts）。
onKeyStroke('Delete', (e) => {
  if (!focusedTreeFolder.value || isAnyDialogOpen.value) {
    return
  }
  e.preventDefault()
  requestDeleteFolder(focusedTreeFolder.value)
})

async function confirmDeleteFolder() {
  const target = pendingDeleteFolder.value
  if (!target || isDeletingFolder.value) {
    return
  }
  isDeletingFolder.value = true
  try {
    await deleteFolder(queryClient, target.path)
    // 正在浏览被删目录（或其子目录）时退回根，保留筛选 query。
    const current = currentFolder.value
    if (current === target.path || current.startsWith(`${target.path}/`)) {
      router.push({ path: '/', query: route.query })
    }
    pendingDeleteFolder.value = null
  }
  catch (error) {
    handleAPIError(error, t('sidebar.deleteFolderFailed', { title: target.title }))
  }
  finally {
    isDeletingFolder.value = false
  }
}

function clearFilter() {
  folderFilter.value = ''
}

interface HighlightPart { text: string, match: boolean }
function splitHighlight(text: string, filter: string): HighlightPart[] {
  const f = filter.trim().toLowerCase()
  if (!f) {
    return [{ text, match: false }]
  }
  const lower = text.toLowerCase()
  const i = lower.indexOf(f)
  if (i === -1) {
    return [{ text, match: false }]
  }
  return [
    { text: text.slice(0, i), match: false },
    { text: text.slice(i, i + f.length), match: true },
    { text: text.slice(i + f.length), match: false },
  ]
}
</script>

<template>
  <a
    href="#main-content"
    class="text-fg px-3 py-2 rounded bg-primary sr-only focus:left-2 focus:top-2 focus:absolute focus:z-9999 focus:not-sr-only"
  >
    {{ $t('common.skipToMain') }}
  </a>
  <DropOverlay />
  <UndoSnackbar />
  <div
    class="text-fg bg-bg flex flex-col h-100vh w-100vw select-none overflow-hidden"
  >
    <FloatWindow v-model="showMenu">
      <div
        role="menu"
        :aria-label="contextTarget?.title"
        class="text-sm border border-border-default rounded-lg bg-surface min-w-44 shadow-lg overflow-hidden"
      >
        <div class="text-xs text-fg-subtle tracking-wide font-semibold px-3 py-2 border-b border-border-subtle uppercase">
          <span class="max-w-60 block truncate">{{ contextTarget?.title ?? $t('sidebar.actions') }}</span>
        </div>
        <ListItem
          :title="$t('sidebar.openFolder')"
          icon="i-tabler-folder-open"
          @click="openFolder"
        />
        <ListItem
          :title="$t('sidebar.copyPath')"
          icon="i-tabler-copy"
          @click="copyPath"
        />
        <ListItem
          :title="$t('sidebar.revealInSystem')"
          icon="i-tabler-external-link"
          @click="revealInExplorer"
        />
        <div class="my-1 border-t border-border-subtle" />
        <ListItem
          :title="$t('sidebar.newSubfolder')"
          icon="i-tabler-folder-plus"
        />
        <ListItem
          :title="$t('sidebar.deleteFolder')"
          icon="i-tabler-folder-x"
          @click="onMenuDeleteFolder"
        />
      </div>
    </FloatWindow>
    <TagSelectorWindow />
    <Splitpanes class="max-h-[calc(100vh-24px)]">
      <Pane
        :min-size="8"
        :size="12"
        :max-size="36"
        class="border-r border-border-default flex flex-col min-w-64"
      >
        <div class="text-xl tracking-tight font-semibold px-3 py-3 flex shrink-0 gap-2 items-center justify-center">
          <img
            src="/Pictoria.svg"
            alt=""
            aria-hidden="true"
            width="20"
            height="20"
            class="h-5 w-5"
          >
          <span>Pictoria</span>
        </div>
        <div class="px-2 pb-2">
          <SpecialPathList />
        </div>
        <div class="px-2 pb-2 flex gap-1.5 items-center">
          <div class="flex-grow relative">
            <i class="i-tabler-search text-fg-subtle h-3.5 w-3.5 left-2.5 top-1/2 absolute -translate-y-1/2" aria-hidden="true" />
            <label for="folder-filter-input" class="sr-only">{{ $t('sidebar.filterFolders') }}</label>
            <input
              id="folder-filter-input"
              v-model="folderFilter"
              type="search"
              name="folder-filter"
              autocomplete="off"
              spellcheck="false"
              :placeholder="$t('sidebar.filterFoldersPlaceholder')"
              class="text-sm text-fg pl-8 pr-7 outline-none border border-border-subtle rounded-md bg-surface h-8 w-full transition-colors focus:border-primary/50 hover:border-border-default focus:bg-bg"
              @keydown.escape="clearFilter"
            >
            <button
              v-if="folderFilter"
              type="button"
              :aria-label="$t('sidebar.clearFilter')"
              class="text-fg-subtle rounded flex h-5 w-5 transition-colors items-center right-1.5 top-1/2 justify-center absolute hover:text-fg hover:bg-surface-1 -translate-y-1/2"
              @click="clearFilter"
            >
              <i class="i-tabler-x h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          <Popover v-model="folderSortShow" position="bottom-end">
            <PButton size="sm" icon variant="secondary" :aria-label="$t('sidebar.sortFolders')" :title="$t('sidebar.sortTitle', { label: sortKeyLabel })">
              <i class="i-tabler-arrows-sort h-3.5 w-3.5" aria-hidden="true" />
            </PButton>
            <template #content>
              <div class="p-1 border border-border-default rounded bg-surface min-w-36 shadow-lg">
                <div class="flex flex-col gap-1">
                  <div class="flex gap-1">
                    <PButton
                      v-for="order in orderOptions"
                      :key="order.id"
                      size="sm"
                      block
                      :variant="folderSortOrder === order.id ? 'primary' : 'secondary'"
                      @click="folderSortOrder = order.id"
                    >
                      <i :class="order.icon" aria-hidden="true" />
                      <span class="flex-grow">{{ $t(order.labelKey) }}</span>
                    </PButton>
                  </div>
                  <PButton
                    v-for="opt in sortOptions"
                    :key="opt.key"
                    size="sm"
                    block
                    :variant="folderSortKey === opt.key ? 'primary' : 'secondary'"
                    @click="folderSortKey = opt.key; folderSortShow = false"
                  >
                    <i :class="opt.icon" aria-hidden="true" />
                    <span class="flex-grow">{{ $t(opt.labelKey) }}</span>
                  </PButton>
                </div>
              </div>
            </template>
          </Popover>
        </div>
        <div class="px-2 pb-1 flex-grow min-h-0">
          <TreeList
            :model-value="currentFolder"
            :open-paths="openPaths"
            :items="folderTree"
            :filter="folderFilter"
            :highlight-chain="highlightChain"
            :item-height="treeItemHeight"
            :loading="foldersQuery.isPending.value && folderTree.length === 0"
            :empty-text="$t('sidebar.noFolderMatch')"
            @update:open-paths="(v) => (openPaths = v)"
            @item-context="onItemContext"
          >
            <template #collapse="{ data, level, isOpen, isSelected, inChain, toggle }">
              <div
                role="treeitem"
                :aria-expanded="isOpen"
                :aria-selected="isSelected"
                :aria-level="level + 1"
                class="h-full relative"
              >
                <RouterLink
                  :to="{ path: `/dir/${data.value}`, query: $route.query }"
                  tabindex="0"
                  :data-tree-value="data.value"
                  :title="data.value"
                  class="group/row text-sm pr-1 rounded-md flex h-full w-full cursor-pointer transition-colors items-center relative focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-inset"
                  :class="[
                    isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                  ]"
                  :style="{ paddingLeft: `${16 + level * 14}px` }"
                  @contextmenu.prevent="onItemContext({ data, event: $event })"
                >
                  <span
                    v-for="i in level"
                    :key="i"
                    class="w-px pointer-events-none bottom-0 top-0 absolute"
                    :class="[
                      inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                    ]"
                    :style="{ left: `${10 + (i - 1) * 14}px` }"
                  />
                  <span
                    v-if="isSelected"
                    class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute"
                  />
                  <div class="flex flex-grow flex-col min-w-0 justify-center">
                    <div class="flex gap-1.5 h-6 items-center">
                      <span aria-hidden="true" class="shrink-0 h-3.5 w-3.5 inline-block" />
                      <span class="truncate">
                        <template
                          v-for="(part, i) in splitHighlight(data.title, folderFilter)"
                          :key="i"
                        >
                          <mark
                            v-if="part.match"
                            class="text-fg px-0.5 rounded-sm bg-primary/30"
                          >{{ part.text }}</mark>
                          <template v-else>{{ part.text }}</template>
                        </template>
                      </span>
                    </div>
                    <FolderStatsLine
                      v-if="data.meta && data.meta.postCount > 0"
                      v-bind="data.meta"
                      class="pl-5"
                    />
                  </div>
                  <span
                    class="text-[10px] font-mono ml-1.5 px-1.5 py-0.5 rounded shrink-0 transition-colors tabular-nums"
                    :class="[
                      isSelected ? 'bg-primary/15 text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
                    ]"
                  >
                    {{ formatNumber(data.count ?? 0) }}
                  </span>
                </RouterLink>
                <button
                  type="button"
                  class="text-fg-subtle rounded flex shrink-0 h-5 w-5 transition items-center top-1/2 justify-center absolute hover:text-fg focus-visible:outline-none hover:bg-surface-2 focus-visible:ring-1 focus-visible:ring-primary/50 -translate-y-1/2"
                  :style="{ left: `${16 + level * 14 - 3}px` }"
                  :aria-label="isOpen ? $t('sidebar.collapse') : $t('sidebar.expand')"
                  :aria-expanded="isOpen"
                  @click.stop.prevent="toggle"
                >
                  <i
                    class="i-tabler-chevron-down h-4 w-4 transition-transform"
                    :class="[isOpen ? 'rotate-0' : '-rotate-90']"
                    aria-hidden="true"
                  />
                </button>
              </div>
            </template>
            <template #link="{ data, level, isSelected, inChain }">
              <RouterLink
                :to="{ path: `/dir/${data.value}`, query: $route.query }"
                role="treeitem"
                :aria-selected="isSelected"
                :aria-level="level + 1"
                tabindex="0"
                :data-tree-value="data.value"
                :title="data.value"
                class="group/row text-sm pr-1 rounded-md flex h-full w-full cursor-pointer transition-colors items-center relative focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:ring-inset"
                :class="[
                  isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                ]"
                :style="{ paddingLeft: `${16 + level * 14}px` }"
                @contextmenu.prevent="onItemContext({ data, event: $event })"
              >
                <span
                  v-for="i in level"
                  :key="i"
                  class="w-px pointer-events-none bottom-0 top-0 absolute"
                  :class="[
                    inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                  ]"
                  :style="{ left: `${10 + (i - 1) * 14}px` }"
                />
                <span
                  v-if="isSelected"
                  class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute"
                />
                <div class="flex flex-grow flex-col min-w-0 justify-center">
                  <div class="flex gap-1.5 h-6 items-center">
                    <span aria-hidden="true" class="inline-flex shrink-0 h-3.5 w-3.5 items-center justify-center">
                      <i v-if="data.icon" class="h-3.5 w-3.5" :class="[data.icon as string]" />
                    </span>
                    <span class="truncate">
                      <template
                        v-for="(part, i) in splitHighlight(data.title, folderFilter)"
                        :key="i"
                      >
                        <mark
                          v-if="part.match"
                          class="text-fg px-0.5 rounded-sm bg-primary/30"
                        >{{ part.text }}</mark>
                        <template v-else>{{ part.text }}</template>
                      </template>
                    </span>
                  </div>
                  <FolderStatsLine
                    v-if="data.meta && data.meta.postCount > 0"
                    v-bind="data.meta"
                    class="pl-5"
                  />
                </div>
                <span
                  v-if="data.count != null"
                  class="text-[10px] font-mono ml-1.5 px-1.5 py-0.5 rounded shrink-0 transition-colors tabular-nums"
                  :class="[
                    isSelected ? 'bg-primary/15 text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
                  ]"
                >
                  {{ formatNumber(data.count) }}
                </span>
              </RouterLink>
            </template>
          </TreeList>
        </div>
        <div class="p-2 border-t border-border-subtle">
          <RouterLink
            to="/settings"
            class="rounded block focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
          >
            <ListItem
              icon="i-tabler-settings"
              :active="$route.path === '/settings'"
              :title="$t('common.settings')"
            />
          </RouterLink>
        </div>
      </Pane>
      <Pane class="relative">
        <main id="main-content" class="h-full">
          <RouterView />
        </main>
      </Pane>
      <Pane
        :min-size="12"
        :size="12"
        :max-size="36"
        class="p-1 border-l border-border-default min-w-64"
      >
        <aside :aria-label="$t('rightPanel.aria')" class="h-full">
          <RightPanel />
        </aside>
      </Pane>
    </Splitpanes>
    <BottomBar />
    <POverlay
      v-if="pendingDeleteFolder"
      class="flex items-center justify-center"
      @click.self="pendingDeleteFolder = null"
    >
      <Dialog
        :title="$t('sidebar.deleteDialogTitle')"
        :confirm-label="isDeletingFolder ? $t('sidebar.deleteDialogDeleting') : $t('sidebar.deleteDialogConfirm')"
        :cancel-label="$t('common.cancel')"
        variant="danger"
        @confirm="confirmDeleteFolder"
        @cancel="pendingDeleteFolder = null"
      >
        <i18n-t keypath="sidebar.deleteDialogBody" tag="p" scope="global" :plural="pendingDeleteFolder.postCount">
          <template #title>
            <span class="text-fg font-medium">{{ pendingDeleteFolder.title }}</span>
          </template>
          <template #count>
            <span class="text-fg font-medium tabular-nums">{{ formatNumber(pendingDeleteFolder.postCount) }}</span>
          </template>
        </i18n-t>
      </Dialog>
    </POverlay>
    <!-- Global toast outlet — useToast()/useAPIError() push here. -->
    <ToastSystem />
  </div>
</template>

<style>
.splitpanes__splitter:hover:before {
  opacity: 1;
  background-color: var(--p-border-strong);
}
.splitpanes--vertical > .splitpanes__splitter:before {left: -4px;right: -4px;height: 100%;}
.splitpanes--vertical .splitpanes__pane {
    transition: none;
    overflow: unset;
}
.splitpanes__splitter {
  width: 4px;
}
</style>
