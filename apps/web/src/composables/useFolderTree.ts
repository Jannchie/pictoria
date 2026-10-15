import type { ComputedRef, InjectionKey, Ref } from 'vue'
import type { TreeListItemData, TreeListLeafData } from '@/ui/PTreeList.vue'
import type { FolderSortKey, FolderSortOrder } from '@/utils/folderTree'
import { useLocalStorage } from '@vueuse/core'
import { computed, inject, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { focusedTreeFolder, isAnyDialogOpen, useCurrentFolder, useFoldersQuery } from '@/shared'
import { shortcuts } from '@/shared/shortcuts'
import { useHotkey } from '@/ui/useHotkey'
import { ancestorPaths, buildFolderTree, findFolderNode, ROOT_FOLDER } from '@/utils/folderTree'

/**
 * State of the sidebar folder tree that must outlive the tree itself.
 *
 * `components/FolderTree.vue` renders inside the left pane, which is unmounted
 * whenever the pane is collapsed. The filter text, the expanded folders (kept
 * in step with navigation even while the pane is hidden), the folders query and
 * a pending delete therefore live here, provided once by App.vue for the app's
 * lifetime, and FolderTree.vue injects them.
 */
export interface FolderTreeState {
  foldersQuery: ReturnType<typeof useFoldersQuery>
  currentFolder: ComputedRef<string>
  folderFilter: Ref<string>
  folderSortKey: Ref<FolderSortKey>
  folderSortOrder: Ref<FolderSortOrder>
  folderTree: ComputedRef<TreeListItemData[]>
  /** Ancestors of the current folder (the tree draws their guide lines). */
  highlightChain: ComputedRef<string[]>
  openPaths: Ref<Set<string>>
  /** The folder awaiting delete confirmation, or null. */
  pendingDeleteFolder: Ref<{ path: string, title: string, postCount: number } | null>
  /** Ask to delete `path` (opens the confirmation); the root is never deletable. */
  requestDeleteFolder: (path: string | null | undefined) => void
}

const folderTreeKey: InjectionKey<FolderTreeState> = Symbol('folderTree')

/** Create the folder-tree state and provide it to descendants. Call once, in App.vue. */
export function provideFolderTree(): FolderTreeState {
  const { t } = useI18n()
  const currentFolder = useCurrentFolder()
  const foldersQuery = useFoldersQuery()
  const folderFilter = ref('')
  // Persisted to localStorage so the chosen folder-tree sort survives reloads.
  const folderSortKey = useLocalStorage<FolderSortKey>('pictoria.folderSort.key', 'name')
  const folderSortOrder = useLocalStorage<FolderSortOrder>('pictoria.folderSort.order', 'asc')

  const folderTree = computed<TreeListItemData[]>(() => buildFolderTree(foldersQuery.data.value, {
    key: folderSortKey.value,
    order: folderSortOrder.value,
    rootTitle: t('sidebar.root'),
  }))

  const highlightChain = computed(() => {
    const path = currentFolder.value
    return !path || path === ROOT_FOLDER ? [] : ancestorPaths(path)
  })

  // Navigating into a folder expands its ancestors (additively: folders the
  // user opened stay open).
  const openPaths = ref(new Set<string>())
  watch(currentFolder, (path) => {
    if (!path) {
      return
    }
    const next = new Set(openPaths.value)
    for (const p of ancestorPaths(path)) {
      next.add(p)
    }
    if (next.size !== openPaths.value.size) {
      openPaths.value = next
    }
  }, { immediate: true })

  const pendingDeleteFolder = ref<{ path: string, title: string, postCount: number } | null>(null)
  function requestDeleteFolder(path: string | null | undefined) {
    if (!path || path === ROOT_FOLDER) {
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

  const state: FolderTreeState = {
    foldersQuery,
    currentFolder,
    folderFilter,
    folderSortKey,
    folderSortOrder,
    folderTree,
    highlightChain,
    openPaths,
    pendingDeleteFolder,
    requestDeleteFolder,
  }
  provide(folderTreeKey, state)
  return state
}

/** The state provided by App.vue's `provideFolderTree()`. */
export function useFolderTree(): FolderTreeState {
  const state = inject(folderTreeKey)
  if (!state) {
    throw new Error('useFolderTree() needs provideFolderTree() in an ancestor (App.vue)')
  }
  return state
}
