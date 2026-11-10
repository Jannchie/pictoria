<script setup lang="ts">
import type { PMenuItem } from '@/ui'
import type { TreeListCollapseData, TreeListLeafData } from '@/ui/PTreeList.vue'
import type { FolderSortKey, FolderSortOrder } from '@/utils/folderTree'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, ref, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { useFolderTree } from '@/composables/useFolderTree'
import { formatNumber } from '@/locale'
import { announce, deleteFolder, RATING_ICON, SCORE_ICON, scorerIcon } from '@/shared'
import PTreeList, { CHEVRON_SLOT, LEVEL_INDENT } from '@/ui/PTreeList.vue'
import { findFolderNode, folderTreeItemHeight, parentFolder, ROOT_FOLDER } from '@/utils/folderTree'
import ConfirmActionDialog from './ConfirmActionDialog.vue'
import FolderTreeRow from './FolderTreeRow.vue'

/**
 * The sidebar folder tree: its filter + sort controls, the virtualised tree,
 * the row context menu and the folder delete confirmation. Rendered as sibling
 * blocks (no wrapper) so it drops straight into the nav's flex column.
 *
 * State that must survive the left pane being collapsed (filter, expanded
 * folders, the folders query, a pending delete, the Delete hotkey) comes from
 * App.vue's `provideFolderTree()`; the tree model is pure, in utils/folderTree.ts.
 */

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const {
  foldersQuery,
  currentFolder,
  folderFilter,
  folderSortKey,
  folderSortOrder,
  folderTree,
  highlightChain,
  openPaths,
  folderDelete,
  requestDeleteFolder,
} = useFolderTree()

const folderSortShow = ref(false)
// Labels stored as message keys (not resolved strings) so a locale switch
// re-renders them without rebuilding the arrays.
const sortOptions: { key: FolderSortKey, labelKey: string, icon: string }[] = [
  { key: 'name', labelKey: 'sidebar.sortName', icon: 'i-tabler-abc' },
  { key: 'count', labelKey: 'sidebar.sortCount', icon: 'i-tabler-files' },
  { key: 'silva', labelKey: 'sidebar.sortSilva', icon: scorerIcon('silva') },
  { key: 'luna', labelKey: 'sidebar.sortSilvaLuna', icon: scorerIcon('silva_luna') },
  { key: 'score', labelKey: 'sidebar.sortScore', icon: SCORE_ICON },
  { key: 'rating', labelKey: 'sidebar.sortRating', icon: RATING_ICON },
]
const orderOptions: { id: FolderSortOrder, labelKey: string, icon: string }[] = [
  { id: 'asc', labelKey: 'sidebar.ascending', icon: 'i-tabler-arrow-up' },
  { id: 'desc', labelKey: 'sidebar.descending', icon: 'i-tabler-arrow-down' },
]
const sortKeyLabel = computed(() => t(sortOptions.find(o => o.key === folderSortKey.value)?.labelKey ?? 'sidebar.sortName'))

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
  { title: t('sidebar.deleteFolder'), icon: 'i-tabler-folder-x', value: 'delete', disabled: contextTarget.value?.value === ROOT_FOLDER },
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

// ── 删除目录（确认框；发起见 useFolderTree 的 requestDeleteFolder） ─────────
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()

// After a delete the row is gone. Focus normally returns to it from the
// dialog and PTreeList then falls back to its nearest surviving ancestor; if
// the dialog found nothing to return to, put focus on the parent row here.
function refocusTreeAfterDelete(path: string) {
  const parent = parentFolder(path)
  setTimeout(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      tree.value?.focusValue(parent)
    }
  }, 50)
}

// On failure the dialog stays open (back to confirming) so the user can retry
// or cancel; handleAPIError toasts the reason.
function confirmDeleteFolder() {
  return folderDelete.confirm({
    run: async (target) => {
      await deleteFolder(queryClient, target.path)
      // 正在浏览被删目录（或其子目录）时退回根，保留筛选 query。
      const current = currentFolder.value
      if (current === target.path || current.startsWith(`${target.path}/`)) {
        router.push({ path: '/', query: route.query })
      }
      announce(t('sidebar.folderDeleted', { title: target.title }))
      refocusTreeAfterDelete(target.path)
    },
    onError: (error, target) => {
      handleAPIError(error, t('sidebar.deleteFolderFailed', { title: target.title }))
    },
  })
}

function clearFilter() {
  folderFilter.value = ''
}
</script>

<template>
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
        <!-- The tree failed to load (and no cached copy): say so, with a way
             to retry — "no matching folders" would read as an empty library. -->
        <PEmpty
          v-if="foldersQuery.isError.value && folderTree.length === 0"
          icon="i-tabler-alert-circle"
          role="alert"
          class="text-xs"
          :retry="foldersQuery.refetch"
          :retrying="foldersQuery.isFetching.value"
        >
          {{ $t('sidebar.loadFailed') }}
        </PEmpty>
        <PTreeList
          v-else
          ref="tree"
          :aria-label="$t('sidebar.folderTree')"
          :model-value="currentFolder"
          :open-paths="openPaths"
          :items="folderTree"
          :filter="folderFilter"
          :highlight-chain="highlightChain"
          :item-height="folderTreeItemHeight"
          :loading="foldersQuery.isPending.value && folderTree.length === 0"
          :empty-text="$t('sidebar.noFolderMatch')"
          @update:open-paths="(v) => (openPaths = v)"
        >
          <!-- Row slots: FolderTreeRow's RouterLink IS the treeitem (role, roving
               tabindex, aria-* and data-tree-value via itemProps), so
               focus and semantics sit on one element. The chevron is a
               mouse-only affordance (←/→ do the same from the keyboard). -->
          <template #collapse="{ data, level, isOpen, isSelected, inChain, toggle, itemProps }">
            <div class="h-full relative">
              <FolderTreeRow
                v-bind="itemProps"
                :data="data"
                :level="level"
                :is-selected="isSelected"
                :in-chain="inChain"
                :filter="folderFilter"
              />
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
            <FolderTreeRow
              v-bind="itemProps"
              :data="data"
              :level="level"
              :is-selected="isSelected"
              :in-chain="inChain"
              :filter="folderFilter"
              :icon="typeof data.icon === 'string' ? data.icon : undefined"
            />
          </template>
        </PTreeList>
      </div>
    </PMenu>
  </div>
  <ConfirmActionDialog
    v-slot="{ target: folder }"
    :action="folderDelete"
    :title="$t('sidebar.deleteDialogTitle')"
    :confirm-label="$t('sidebar.deleteDialogConfirm')"
    :busy-label="$t('sidebar.deleteDialogDeleting')"
    @confirm="confirmDeleteFolder"
  >
    <i18n-t keypath="sidebar.deleteDialogBody" tag="p" scope="global" :plural="folder.postCount">
      <template #title>
        <span class="text-fg font-medium">{{ folder.title }}</span>
      </template>
      <template #count>
        <span class="text-fg font-medium tabular-nums">{{ formatNumber(folder.postCount) }}</span>
      </template>
    </i18n-t>
  </ConfirmActionDialog>
</template>
