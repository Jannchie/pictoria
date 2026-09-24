/**
 * Picking which sub-folder shortcuts to show above the gallery grid.
 *
 * A folder can have tens of thousands of direct children (one per artist in a
 * booru mirror), so the strip never renders "all of them": a short preview of
 * the biggest ones, and a filter for the rest. Rendering every child as a
 * RouterLink put ~25k components above the grid and froze the page for 20 s.
 */

export interface FolderNodeLike {
  name: string
  path: string
  fileCount: number
  children?: FolderNodeLike[] | null
}

/**
 * Direct children of `folder` (`'@'` = root), walking the tree one path
 * segment at a time — works at any depth, not only for top-level folders.
 */
export function childrenOf<T extends FolderNodeLike>(root: T | null | undefined, folder: string): T[] {
  if (!root) {
    return []
  }
  if (folder === '@' || folder === '' || folder === '.') {
    return (root.children ?? []) as T[]
  }
  let node: FolderNodeLike | undefined = root
  let prefix = ''
  for (const segment of folder.split('/')) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    node = node?.children?.find(c => c.path === prefix)
    if (!node) {
      return []
    }
  }
  return (node.children ?? []) as T[]
}

/** How many shortcuts the collapsed strip shows. */
export const SUBFOLDER_PREVIEW = 24
/** Cap on filtered results while expanded (a scrolling list of chips). */
export const SUBFOLDER_RESULTS = 200

/**
 * The collapsed preview. A short list keeps its natural (tree) order; a long
 * one shows the biggest folders — the useful few out of thousands.
 */
export function previewSubfolders<T extends FolderNodeLike>(children: readonly T[], limit = SUBFOLDER_PREVIEW): T[] {
  if (children.length <= limit) {
    return [...children]
  }
  return topByCount(children, limit)
}

/**
 * Filter by name (case-insensitive substring; `_` and space are the same),
 * prefix matches first, then by file count. Empty filter → biggest first.
 * Returns at most `limit` items plus the total match count.
 */
export function filterSubfolders<T extends FolderNodeLike>(
  children: readonly T[],
  filter: string,
  limit = SUBFOLDER_RESULTS,
): { items: T[], total: number } {
  const q = normalize(filter)
  if (!q) {
    return { items: topByCount(children, limit), total: children.length }
  }
  const prefix: T[] = []
  const infix: T[] = []
  for (const c of children) {
    const name = normalize(c.name)
    if (name.startsWith(q)) {
      prefix.push(c)
    }
    else if (name.includes(q)) {
      infix.push(c)
    }
  }
  const byCount = (a: T, b: T) => b.fileCount - a.fileCount
  prefix.sort(byCount)
  infix.sort(byCount)
  return { items: [...prefix, ...infix].slice(0, limit), total: prefix.length + infix.length }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replaceAll('_', ' ')
}

/** Top `limit` by file count without sorting the whole (possibly huge) list. */
function topByCount<T extends FolderNodeLike>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) {
    return [...items].sort((a, b) => b.fileCount - a.fileCount)
  }
  const top: T[] = []
  for (const item of items) {
    if (top.length < limit) {
      top.push(item)
      if (top.length === limit) {
        top.sort((a, b) => b.fileCount - a.fileCount)
      }
      continue
    }
    if (item.fileCount <= top[limit - 1].fileCount) {
      continue
    }
    // Insert in place (limit is small), dropping the smallest.
    let i = limit - 1
    while (i > 0 && top[i - 1].fileCount < item.fileCount) {
      top[i] = top[i - 1]
      i--
    }
    top[i] = item
  }
  return top
}
