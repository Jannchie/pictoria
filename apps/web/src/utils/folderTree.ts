import type { DirectorySummary } from '@/api'
import type { TreeListItemData, TreeListLeafData } from '@/ui/treeListModel'

/**
 * Pure model of the sidebar folder tree: sorting, the server summary →
 * PTreeList items conversion, row heights and path helpers. The component
 * (`components/FolderTree.vue`) owns the state and the menu; everything here
 * is plain data in, plain data out.
 */

export type FolderSortKey = 'name' | 'count' | 'silva' | 'luna' | 'score' | 'rating'
export type FolderSortOrder = 'asc' | 'desc'

/** The tree's own value for the library root row (it routes to `/dir/@`). */
export const ROOT_FOLDER = '@'

/** Per-row stats carried on each item's `meta` for the second (stats) line. */
export interface FolderStats {
  silvaAvg: number | null
  scoreAvg: number | null
  ratingAvg: number | null
  scoredRatio: number | null
  postCount: number
}

export function folderStats(d: DirectorySummary): FolderStats {
  return {
    silvaAvg: d.silvaAvg,
    scoreAvg: d.scoreAvg,
    ratingAvg: d.ratingAvg,
    scoredRatio: d.scoredRatio,
    postCount: d.postCount ?? 0,
  }
}

function sortValue(d: DirectorySummary, key: FolderSortKey): number | string {
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

/**
 * Sort one level of directories by `key` / `order` (a new array). Missing
 * score averages sort as -1, so unscored folders sink to the bottom in desc.
 */
export function sortFolders(nodes: DirectorySummary[], key: FolderSortKey, order: FolderSortOrder): DirectorySummary[] {
  const dir = order === 'asc' ? 1 : -1
  return [...nodes].sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (typeof va === 'string' && typeof vb === 'string') {
      return dir * va.localeCompare(vb)
    }
    return dir * ((va as number) - (vb as number))
  })
}

/** A directory's children as tree items, each level sorted, recursively. */
export function folderChildrenToTree(dir: DirectorySummary, key: FolderSortKey, order: FolderSortOrder): TreeListItemData[] {
  return sortFolders(dir.children ?? [], key, order).map((child): TreeListItemData => {
    const base = {
      title: child.name,
      value: child.path,
      count: child.fileCount,
      meta: folderStats(child),
    }
    if ((child.children?.length ?? 0) > 0) {
      return { ...base, children: folderChildrenToTree(child, key, order) }
    }
    return base
  })
}

/** The whole sidebar tree: a root row for the library itself, then its sorted children. */
export function buildFolderTree(
  root: DirectorySummary | undefined | null,
  options: { key: FolderSortKey, order: FolderSortOrder, rootTitle: string },
): TreeListItemData[] {
  if (!root) {
    return []
  }
  return [
    {
      title: options.rootTitle,
      value: ROOT_FOLDER,
      count: root.fileCount,
      meta: folderStats(root),
    },
    ...folderChildrenToTree(root, options.key, options.order),
  ]
}

/**
 * The second row carries the file count and the score averages; an empty
 * folder has neither, so it collapses to a single line.
 */
export function hasStatsLine(item: TreeListLeafData): boolean {
  return (item.count ?? 0) > 0 || (item.meta?.postCount ?? 0) > 0
}

/**
 * Virtual-list row heights — MUST match what the row slots render, or rows
 * overlap / jump. Folders with a stats line are taller.
 */
export function folderTreeItemHeight(item: TreeListItemData): number {
  if (!('value' in item) && !('children' in item)) {
    return 28 // header
  }
  return hasStatsLine(item as TreeListLeafData) ? 48 : 32
}

/** Depth-first lookup of the item whose value is `path`. */
export function findFolderNode(items: TreeListItemData[], path: string): TreeListItemData | null {
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

/** `a/b/c` → `['a', 'a/b', 'a/b/c']` (empty segments dropped). */
export function ancestorPaths(path: string): string[] {
  const chain: string[] = []
  let acc = ''
  for (const seg of path.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg
    chain.push(acc)
  }
  return chain
}

/** The row focus falls back to after `path` is deleted: its parent, or the root. */
export function parentFolder(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ROOT_FOLDER
}
