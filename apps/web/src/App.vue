<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue'
import type { DirectorySummary } from '@/api'
import type { PMenuItem } from '@/ui'
import type { TreeListCollapseData, TreeListItemData, TreeListLeafData } from '@/ui/PTreeList.vue'
import { useQueryClient } from '@tanstack/vue-query'
import { useResizeObserver } from '@vueuse/core'
import { Pane, Splitpanes } from 'splitpanes'
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, START_LOCATION, useRoute, useRouter } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { useGlobalUndoRedo } from '@/composables/useGlobalUndoRedo'
import { useHotkey } from '@/composables/useHotkey'
import { usePaneSplitters } from '@/composables/usePaneSplitters'
import { usePostQuery } from '@/composables/usePostQuery'
import { useWatchRoute } from '@/composables/useWatchRoute'
import { formatNumber } from '@/locale'
import { shortcuts } from '@/shared/shortcuts'
import PTreeList, { CHEVRON_SLOT, LEVEL_INDENT } from '@/ui/PTreeList.vue'
import { formatShortcut } from '@/utils/keyboard'
import { routeTitle, shouldAnnounceRoute, shouldFocusMain } from '@/utils/routeAnnounce'
import FolderStatsLine from './components/FolderStatsLine.vue'
import { announce, commandPaletteOpen, deleteFolder, focusedTreeFolder, hasModalLayer, isAnyDialogOpen, leftPaneCollapsed, rightPaneCollapsed, shortcutHelpOpen, useCurrentFolder, useFoldersQuery, useSyncFilterWithUrl } from './shared'
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

type FolderSortKey = 'name' | 'count' | 'silva' | 'luna' | 'score' | 'rating'
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
  { key: 'luna', labelKey: 'sidebar.sortSilvaLuna', icon: 'i-tabler-moon' },
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
      case 'count': { return d.fileCount ?? 0
      }
      case 'silva': { return d.silvaAvg ?? -1
      }
      case 'luna': { return d.silvaLunaAvg ?? -1
      }
      case 'score': { return d.scoreAvg ?? -1
      }
      case 'rating': { return d.ratingAvg ?? -1
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
    silvaAvg: d.silvaAvg,
    scoreAvg: d.scoreAvg,
    ratingAvg: d.ratingAvg,
    scoredRatio: d.scoredRatio,
    postCount: d.postCount ?? 0,
  }
}

// The second row carries the file count and the score averages; an empty
// folder has neither, so it collapses to a single line.
function hasStatsLine(item: TreeListLeafData): boolean {
  return (item.count ?? 0) > 0 || (item.meta?.postCount ?? 0) > 0
}

// Virtual-list row heights — MUST match what the row slots render, or rows
// overlap / jump. Folders with a stats line are taller.
function treeItemHeight(item: TreeListItemData): number {
  if (!('value' in item) && !('children' in item)) {
    return 28 // header
  }
  return hasStatsLine(item as TreeListLeafData) ? 48 : 32
}

function convertPathToTree(path: DirectorySummary): TreeListItemData[] {
  const children = sortNodes(path.children ?? [])
  return children.map((child): TreeListItemData => {
    const base = {
      title: child.name,
      value: child.path,
      count: child.fileCount,
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
      count: root.fileCount,
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

// ── Folder-tree context menu (PMenu: right-click, or Shift+F10 / ContextMenu
// on the focused row) ───────────────────────────────────────────────────────
const tree = useTemplateRef<{ focusValue: (value: string) => void, focus: () => void }>('tree')
const contextTarget = ref<TreeListLeafData | TreeListCollapseData | null>(null)

const treeMenuItems = computed<PMenuItem[]>(() => [
  { role: 'label', title: contextTarget.value?.title ?? t('sidebar.actions') },
  { title: t('sidebar.openFolder'), icon: 'i-tabler-folder-open', value: 'open' },
  { title: t('sidebar.copyPath'), icon: 'i-tabler-copy', value: 'copy' },
  { role: 'divider' },
  // The root is the library itself — it can't be deleted.
  { title: t('sidebar.deleteFolder'), icon: 'i-tabler-folder-x', value: 'delete', disabled: contextTarget.value?.value === '@' },
])

// Which folder a context-menu event is about: the tree row it came from, or —
// for the menu key while focus is parked on the tree container (see
// PTreeList) — the container's cursor value.
function treeValueFromTarget(target: EventTarget | null): string | undefined {
  if (!(target instanceof HTMLElement)) {
    return undefined
  }
  const row = target.closest<HTMLElement>('[role="treeitem"][data-tree-value]')
  if (row) {
    return row.dataset.treeValue
  }
  if (target === document.activeElement && target.getAttribute('role') === 'tree') {
    return target.dataset.treeValue
  }
  return undefined
}
function setContextTarget(value: string | undefined): boolean {
  const node = value ? findFolderNode(folderTree.value, value) : null
  contextTarget.value = node && 'value' in node ? node as TreeListLeafData | TreeListCollapseData : null
  return contextTarget.value !== null
}
// Runs before PMenu's own contextmenu handler (bubble order: row → this
// wrapper → PMenu host). Outside a row there is no folder to act on: no menu.
function onTreeContextMenu(e: MouseEvent) {
  if (!setContextTarget(treeValueFromTarget(e.target))) {
    e.preventDefault()
    e.stopPropagation()
  }
}
// PMenu may open its keyboard menu straight from keydown, without a
// contextmenu event — resolve the target from the focused row first.
function onTreeKeydownCapture(e: KeyboardEvent) {
  if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
    setContextTarget(treeValueFromTarget(e.target))
  }
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    announce(t('sidebar.pathCopied'))
  }
  catch {
    announce(t('sidebar.copyPathFailed'), 'assertive')
  }
}

function onTreeMenuSelect(action: string | number | symbol) {
  const path = contextTarget.value?.value
  if (!path) {
    return
  }
  switch (action) {
    case 'open': {
      router.push({ path: `/dir/${path}`, query: route.query })
      break
    }
    case 'copy': {
      copyPath(path)
      break
    }
    case 'delete': {
      requestDeleteFolder(path)
      break
    }
  }
}

// ── 删除目录（树行获得焦点时按 Delete，或右键菜单） ──────────────────────
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
const pendingDeleteFolder = ref<{ path: string, title: string, postCount: number } | null>(null)
const isDeletingFolder = ref(false)

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

// 树行（role=treeitem，带 data-tree-value）获得焦点时按 Delete 删除该目录。树行是
// widget，画廊的"删除选中图片"热键（useHotkey 默认跳过 widget）自然让位。
useHotkey(shortcuts.folderTree.deleteFolder.keys, () => requestDeleteFolder(focusedTreeFolder.value), {
  when: () => Boolean(focusedTreeFolder.value) && !isAnyDialogOpen.value,
  allowInWidgets: true,
})

// After a delete the row is gone. Focus normally returns to it from the
// dialog and PTreeList then falls back to its nearest surviving ancestor; if
// the dialog found nothing to return to, put focus on the parent row here.
function refocusTreeAfterDelete(path: string) {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '@'
  setTimeout(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      tree.value?.focusValue(parent)
    }
  }, 50)
}

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
    announce(t('sidebar.folderDeleted', { title: target.title }))
    refocusTreeAfterDelete(target.path)
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

// ── Global hotkeys ──────────────────────────────────────────────────────────
// ⌘K / Ctrl+K opens the palette from anywhere, including from inside an input
// (that's the point — it's the one key that always works).
useHotkey(shortcuts.global.openPalette.keys, () => {
  commandPaletteOpen.value = !commandPaletteOpen.value
}, { allowInTyping: true, allowInWidgets: true })

// '?' opens the shortcut sheet, but only when not typing — otherwise it would
// swallow the character in the folder filter or a caption field.
useHotkey(shortcuts.global.openHelp.keys, () => {
  shortcutHelpOpen.value = true
}, { allowInWidgets: true, when: () => !isAnyDialogOpen.value })

// Pane toggles. Mod+B / Mod+Shift+B mirror the editor convention; the same
// state is driven by the bottom bar's buttons, which stay reachable once a
// pane is gone (the pane's own header would collapse with it).
useHotkey(shortcuts.global.toggleLeft.keys, () => {
  leftPaneCollapsed.value = !leftPaneCollapsed.value
}, { allowInTyping: true, allowInWidgets: true, when: () => !isAnyDialogOpen.value })
useHotkey(shortcuts.global.toggleRight.keys, () => {
  rightPaneCollapsed.value = !rightPaneCollapsed.value
}, { allowInTyping: true, allowInWidgets: true, when: () => !isAnyDialogOpen.value })

// ── Layout: pane sizes, keyboard splitters, F6 landmark cycling ─────────────
const LEFT_PANE = { min: 8, max: 36 }
const RIGHT_PANE = { min: 12, max: 36 }
// Sizes (percent) live here so the keyboard splitters can set them; drags
// write them back through @resize / @resized. The centre takes the rest.
const leftSize = ref(12)
const rightSize = ref(12)
const centerSize = computed(() =>
  100 - (leftPaneCollapsed.value ? 0 : leftSize.value) - (rightPaneCollapsed.value ? 0 : rightSize.value))
function onPanesResized({ panes }: { panes: { size: number }[] }) {
  let i = 0
  if (!leftPaneCollapsed.value) {
    if (panes[i]) {
      leftSize.value = panes[i].size
    }
    i++
  }
  i++ // the centre pane
  if (!rightPaneCollapsed.value && panes[i]) {
    rightSize.value = panes[i].size
  }
}

const split = useTemplateRef<ComponentPublicInstance>('split')
// Side panes also carry a pixel floor (min-w-64 = 256px). Below it the
// percent size is fiction: the pane stays 256px wide, so keyboard steps did
// nothing visible and aria-valuenow lied. Convert the floor to a percent of
// the layout width and use it as the effective minimum.
const SIDE_PANE_MIN_PX = 256
const splitWidth = ref(0)
useResizeObserver(() => split.value?.$el as HTMLElement | undefined, ([entry]) => {
  splitWidth.value = entry.contentRect.width
})
function floorPct(base: { min: number, max: number }) {
  if (splitWidth.value <= 0) {
    return base.min
  }
  return Math.min(base.max, Math.max(base.min, Math.ceil(SIDE_PANE_MIN_PX / splitWidth.value * 100)))
}
const leftMin = computed(() => floorPct(LEFT_PANE))
const rightMin = computed(() => floorPct(RIGHT_PANE))
watch(leftMin, (min) => {
  if (leftSize.value < min) {
    leftSize.value = min
  }
})
watch(rightMin, (min) => {
  if (rightSize.value < min) {
    rightSize.value = min
  }
})
const navEl = useTemplateRef<HTMLElement>('navEl')
const mainEl = useTemplateRef<HTMLElement>('mainEl')
const asideEl = useTemplateRef<HTMLElement>('asideEl')

// Enter on a splitter hides its pane. The splitter goes with it, so focus
// moves to the main area and the way back is announced.
function collapsePane(side: 'left' | 'right') {
  if (side === 'left') {
    leftPaneCollapsed.value = true
  }
  else {
    rightPaneCollapsed.value = true
  }
  nextTick(() => mainEl.value?.focus({ preventScroll: true }))
  announce(side === 'left'
    ? t('pane.leftHidden', { key: formatShortcut(shortcuts.global.toggleLeft.keys[0]) })
    : t('pane.rightHidden', { key: formatShortcut(shortcuts.global.toggleRight.keys[0]) }))
}

usePaneSplitters(() => split.value?.$el as HTMLElement | undefined, [
  { id: 'pane-left', side: 'left', size: leftSize, min: leftMin, max: LEFT_PANE.max, label: () => t('pane.resizeLeft'), collapse: () => collapsePane('left') },
  { id: 'pane-right', side: 'right', size: rightSize, min: rightMin, max: RIGHT_PANE.max, label: () => t('pane.resizeRight'), collapse: () => collapsePane('right') },
])

// F6 / Shift+F6 cycle focus through the landmarks (sidebar nav → main →
// detail aside), skipping collapsed panes. The landmark element itself takes
// focus (its name is announced, Tab continues inside it); nav/aside get a
// temporary tabindex that is dropped on blur so mouse clicks never land on them.
function focusRegion(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true })
  }
  el.focus({ preventScroll: true })
}
useHotkey(shortcuts.global.cycleRegions.keys, (e) => {
  const regions = [navEl.value, mainEl.value, asideEl.value].filter((el): el is HTMLElement => !!el?.isConnected)
  if (regions.length === 0) {
    return
  }
  const active = document.activeElement
  const current = regions.findIndex(el => el.contains(active))
  const dir = e.shiftKey ? -1 : 1
  const next = current === -1
    ? (dir === 1 ? 0 : regions.length - 1)
    : (current + dir + regions.length) % regions.length
  focusRegion(regions[next])
}, { allowInTyping: true, allowInWidgets: true, when: () => !hasModalLayer.value })

// ── Route changes: document.title, announcement, focus ──────────────────────
// The policy (which navigations announce / move focus) is in
// utils/routeAnnounce.ts, with tests.
const routePostId = computed(() => (route.name === 'post' ? Number(route.params.postId) : undefined))
const { data: routePost } = usePostQuery(routePostId)
const pageTitle = computed(() => {
  const post = routePost.value
  const postName = post && post.id === routePostId.value ? `${post.fileName}.${post.extension}` : null
  const title = routeTitle(route, postName)
  return title.key ? t(title.key, title.params ?? {}) : (title.text ?? '')
})
watchEffect(() => {
  document.title = t('route.documentTitle', { title: pageTitle.value })
})

const removeAfterEach = router.afterEach((to, from, failure) => {
  if (failure) {
    return
  }
  const initial = from === START_LOCATION
  const announceIt = shouldAnnounceRoute(to, from, initial)
  const focusIt = shouldFocusMain(to, from, initial)
  if (!announceIt && !focusIt) {
    return
  }
  // Route views are lazy chunks: give the new view a moment to mount (and to
  // place focus itself) before judging where focus is.
  setTimeout(() => {
    if (announceIt) {
      announce(t('route.navigated', { title: pageTitle.value }))
    }
    const main = mainEl.value
    const active = document.activeElement
    const focusInMain = !!main && !!active && active !== document.body && main.contains(active)
    // A folder picked in the tree keeps focus in the tree.
    const inTree = active instanceof HTMLElement && active.closest('[role="tree"]') !== null
    if (focusIt && main && !focusInMain && !inTree && !hasModalLayer.value) {
      main.focus({ preventScroll: true })
    }
  }, 50)
})
onBeforeUnmount(removeAfterEach)

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
    <TagSelectorWindow />
    <Splitpanes
      ref="split"
      class="max-h-[calc(100vh-24px)]"
      :keyboard-step="0"
      @resize="onPanesResized"
      @resized="onPanesResized"
    >
      <Pane
        v-if="!leftPaneCollapsed"
        id="pane-left"
        :min-size="leftMin"
        :size="leftSize"
        :max-size="LEFT_PANE.max"
        class="border-r border-border-subtle min-w-64"
      >
        <nav
          ref="navEl"
          :aria-label="$t('nav.aria')"
          class="flex flex-col h-full focus-visible:[outline-offset:-2px]"
        >
          <!-- Wordmark sits on the nav rows' icon column (24px: pane px-2 + row
               px-4) at body size: it is a label for the pane, not a hero. -->
          <div class="text-base tracking-tight font-semibold px-6 pb-1.5 pt-3 flex shrink-0 gap-2 items-center">
            <img
              src="/Pictoria.svg"
              alt=""
              aria-hidden="true"
              width="16"
              height="16"
              class="h-4 w-4"
            >
            <span>Pictoria</span>
          </div>
          <div class="px-2 pb-2">
            <SpecialPathList />
          </div>
          <div class="px-2 pb-2 flex gap-1.5 items-center">
            <div class="flex-grow relative">
              <i class="i-tabler-search text-fg-subtle h-3.5 w-3.5 pointer-events-none left-2.5 top-1/2 absolute -translate-y-1/2" aria-hidden="true" />
              <label for="folder-filter-input" class="sr-only">{{ $t('sidebar.filterFolders') }}</label>
              <input
                id="folder-filter-input"
                v-model="folderFilter"
                type="search"
                name="folder-filter"
                autocomplete="off"
                spellcheck="false"
                :placeholder="$t('sidebar.filterFoldersPlaceholder')"
                class="text-sm text-fg pl-8 pr-7 outline-none border border-border-subtle rounded-md bg-surface-1 h-7 w-full transition-colors placeholder:text-fg-subtle focus:border-primary/60 hover:border-border-default focus:bg-bg"
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
            <PPopover v-model="folderSortShow" position="bottom-end">
              <PButton size="sm" icon variant="ghost" :active="folderSortShow" :aria-label="$t('sidebar.sortFolders')" :title="$t('sidebar.sortTitle', { label: sortKeyLabel })">
                <i class="i-tabler-arrows-sort" aria-hidden="true" />
              </PButton>
              <template #content>
                <div class="p-popover-panel min-w-40">
                  <div class="mb-1 pb-1 p-divider flex gap-1">
                    <PButton
                      v-for="order in orderOptions"
                      :key="order.id"
                      size="sm"
                      block
                      :variant="folderSortOrder === order.id ? 'subtle' : 'ghost'"
                      :aria-pressed="folderSortOrder === order.id"
                      @click="folderSortOrder = order.id"
                    >
                      <i :class="order.icon" aria-hidden="true" />
                      <span class="flex-grow">{{ $t(order.labelKey) }}</span>
                    </PButton>
                  </div>
                  <div role="group" :aria-label="$t('sidebar.sortFolders')" class="flex flex-col">
                    <PButton
                      v-for="opt in sortOptions"
                      :key="opt.key"
                      size="sm"
                      block
                      :variant="folderSortKey === opt.key ? 'subtle' : 'ghost'"
                      :aria-pressed="folderSortKey === opt.key"
                      class="justify-start!"
                      @click="folderSortKey = opt.key; folderSortShow = false"
                    >
                      <i :class="[opt.icon, folderSortKey === opt.key ? 'text-primary' : 'text-fg-subtle']" aria-hidden="true" />
                      <span class="text-left flex-grow">{{ $t(opt.labelKey) }}</span>
                    </PButton>
                  </div>
                </div>
              </template>
            </PPopover>
          </div>
          <div class="px-2 pb-1 flex-grow min-h-0">
            <PMenu
              :data="treeMenuItems"
              :aria-label="$t('sidebar.folderActions')"
              class="h-full"
              @select="onTreeMenuSelect"
            >
              <div
                class="h-full"
                @contextmenu="onTreeContextMenu"
                @keydown.capture="onTreeKeydownCapture"
              >
                <PTreeList
                  ref="tree"
                  :aria-label="$t('sidebar.folderTree')"
                  :model-value="currentFolder"
                  :open-paths="openPaths"
                  :items="folderTree"
                  :filter="folderFilter"
                  :highlight-chain="highlightChain"
                  :item-height="treeItemHeight"
                  :loading="foldersQuery.isPending.value && folderTree.length === 0"
                  :empty-text="$t('sidebar.noFolderMatch')"
                  @update:open-paths="(v) => (openPaths = v)"
                >
                  <!-- Row slots: the RouterLink IS the treeitem (role, roving
                       tabindex, aria-* and data-tree-value via itemProps), so
                       focus and semantics sit on one element. The chevron is a
                       mouse-only affordance (←/→ do the same from the keyboard). -->
                  <template #collapse="{ data, level, isOpen, isSelected, inChain, toggle, itemProps }">
                    <div class="h-full relative">
                      <RouterLink
                        v-bind="itemProps"
                        :to="{ path: `/dir/${data.value}`, query: $route.query }"
                        :title="data.value"
                        class="group/row text-sm pr-3 rounded-md flex h-full w-full cursor-pointer transition-colors items-center relative focus-visible:[outline-offset:-2px]"
                        :class="[
                          isSelected ? 'text-fg bg-primary/10 hover:bg-primary/15' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                        ]"
                        :style="{ paddingLeft: `${CHEVRON_SLOT + level * LEVEL_INDENT}px` }"
                      >
                        <span
                          v-for="i in level"
                          :key="i"
                          aria-hidden="true"
                          class="w-px pointer-events-none bottom-0 top-0 absolute"
                          :class="[
                            inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                          ]"
                          :style="{ left: `${10 + (i - 1) * LEVEL_INDENT}px` }"
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
                            v-if="hasStatsLine(data)"
                            v-bind="data.meta"
                            :count="data.count"
                            class="pl-5"
                          />
                        </div>
                      </RouterLink>
                      <span
                        aria-hidden="true"
                        class="text-fg-subtle rounded flex shrink-0 h-5 w-5 cursor-pointer transition-colors items-center top-1/2 justify-center absolute hover:text-fg hover:bg-surface-2 -translate-y-1/2"
                        :style="{ left: `${CHEVRON_SLOT + level * LEVEL_INDENT - 3}px` }"
                        @mousedown.prevent
                        @click.stop.prevent="toggle"
                      >
                        <i
                          class="i-tabler-chevron-down h-4 w-4 transition-transform"
                          :class="[isOpen ? 'rotate-0' : '-rotate-90']"
                        />
                      </span>
                    </div>
                  </template>
                  <template #link="{ data, level, isSelected, inChain, itemProps }">
                    <RouterLink
                      v-bind="itemProps"
                      :to="{ path: `/dir/${data.value}`, query: $route.query }"
                      :title="data.value"
                      class="group/row text-sm pr-3 rounded-md flex h-full w-full cursor-pointer transition-colors items-center relative focus-visible:[outline-offset:-2px]"
                      :class="[
                        isSelected ? 'text-fg bg-primary/10 hover:bg-primary/15' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
                      ]"
                      :style="{ paddingLeft: `${CHEVRON_SLOT + level * LEVEL_INDENT}px` }"
                    >
                      <span
                        v-for="i in level"
                        :key="i"
                        aria-hidden="true"
                        class="w-px pointer-events-none bottom-0 top-0 absolute"
                        :class="[
                          inChain && i === level ? 'bg-primary/40' : 'bg-border-subtle',
                        ]"
                        :style="{ left: `${10 + (i - 1) * LEVEL_INDENT}px` }"
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
                          v-if="hasStatsLine(data)"
                          v-bind="data.meta"
                          :count="data.count"
                          class="pl-5"
                        />
                      </div>
                    </RouterLink>
                  </template>
                </PTreeList>
              </div>
            </PMenu>
          </div>
          <div class="border-t border-border-subtle">
            <SyncStatus />
            <div class="p-2">
              <RouterLink
                to="/settings"
                class="rounded block"
              >
                <PListItem
                  class="px-4!"
                  icon="i-tabler-settings"
                  :active="$route.path === '/settings'"
                  :title="$t('common.settings')"
                />
              </RouterLink>
            </div>
          </div>
        </nav>
      </Pane>
      <Pane id="pane-main" :size="centerSize" class="relative">
        <main
          id="main-content"
          ref="mainEl"
          tabindex="-1"
          class="h-full focus-visible:[outline-offset:-2px]"
        >
          <RouterView />
        </main>
      </Pane>
      <Pane
        v-if="!rightPaneCollapsed"
        id="pane-right"
        :min-size="rightMin"
        :size="rightSize"
        :max-size="RIGHT_PANE.max"
        class="border-l border-border-subtle min-w-64"
      >
        <aside
          ref="asideEl"
          :aria-label="$t('rightPanel.aria')"
          class="h-full focus-visible:[outline-offset:-2px]"
        >
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
      <PDialog
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
      </PDialog>
    </POverlay>
    <!-- Global toast outlet — useToast()/useAPIError() push here. -->
    <ToastSystem />
    <!-- ⌘K palette + its shortcut sheet; both are global singletons. -->
    <CommandPalette />
    <ShortcutHelp />
  </div>
</template>

<style>
.splitpanes__splitter:before {
  transition: opacity var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
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
/* Keyboard-operable splitters (usePaneSplitters): splitpanes' own stylesheet
   sets outline:none on :focus, so restore a ring for keyboard focus. */
.splitpanes .splitpanes__splitter:focus-visible {
  outline: var(--p-focus-ring);
  outline-offset: -1px;
  background-color: var(--p-primary);
}
</style>
