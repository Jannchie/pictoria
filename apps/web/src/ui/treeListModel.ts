// Pure model behind PTreeList: flattening the (filtered) tree into the rows the
// virtual list renders, and resolving tree navigation keys to an action. Kept
// DOM-free so the WAI-ARIA tree keyboard model is unit-tested
// (src/test/treeListModel.test.ts).
import type { VNode } from 'vue'

export interface TreeListLeafData {
  icon?: string | VNode
  title: string
  value: string
  count?: number
  meta?: any
  attrs?: Record<string, any>
  is?: string | VNode
}

export interface TreeListHeaderData {
  icon?: string | VNode
  title: string
}

export interface TreeListCollapseData {
  icon?: string | VNode
  title: string
  value?: string
  count?: number
  meta?: any
  children?: TreeListItemData[]
  open?: boolean
}

export type TreeListItemData = TreeListLeafData | TreeListHeaderData | TreeListCollapseData

export function hasChildren(it: TreeListItemData): it is TreeListCollapseData {
  return 'children' in it && Array.isArray((it as TreeListCollapseData).children)
}
export function isLeaf(it: TreeListItemData): it is TreeListLeafData {
  return 'value' in it && !('children' in it)
}
// Not a type guard: TreeListHeaderData is a structural subset of the other two
// shapes, so narrowing on it would turn the else-branch into `never`.
export function isHeader(it: TreeListItemData): boolean {
  return !isLeaf(it) && !hasChildren(it)
}

export interface FlatTreeRow {
  item: TreeListItemData
  type: 'link' | 'collapse' | 'header'
  level: number
  /** Values of the ancestor branches, outermost first. */
  parents: string[]
  /** Row value (folder path); undefined for headers and value-less branches. */
  value: string | undefined
  /** Effective expansion (branches only). */
  open: boolean
  /** A filter is active, which shows every branch expanded — collapsing it would be a no-op. */
  forcedOpen: boolean
  /** 1-based position among the tree items sharing this parent. 0 for headers. */
  posinset: number
  /** Number of tree items sharing this parent. 0 for headers. */
  setsize: number
  /** Tree items sharing this parent (for `*` = expand all siblings). */
  siblings: TreeListItemData[]
}

export interface FlattenOptions {
  /** Keep the item (its subtree matches the filter). Default: keep all. */
  keep?: (item: TreeListItemData) => boolean
  /** Is this branch expanded by the user? */
  isOpen: (value: string) => boolean
  /** A filter is active: every kept branch is shown expanded. */
  forceOpen?: boolean
}

/** The whole visible tree as a flat list — the virtual scroller renders a window of these. */
export function flattenTree(items: TreeListItemData[], options: FlattenOptions): FlatTreeRow[] {
  const keep = options.keep ?? (() => true)
  const forceOpen = options.forceOpen ?? false
  const rows: FlatTreeRow[] = []
  const walk = (list: TreeListItemData[], level: number, parents: string[]) => {
    const shown = list.filter(keep)
    const siblings = shown.filter(it => !isHeader(it))
    let pos = 0
    for (const it of shown) {
      if (isHeader(it)) {
        rows.push({ item: it, type: 'header', level, parents, value: undefined, open: false, forcedOpen: false, posinset: 0, setsize: 0, siblings: [] })
        continue
      }
      pos++
      if (hasChildren(it)) {
        const userOpen = it.value ? options.isOpen(it.value) : true
        const open = forceOpen || userOpen
        rows.push({ item: it, type: 'collapse', level, parents, value: it.value || undefined, open, forcedOpen: forceOpen, posinset: pos, setsize: siblings.length, siblings })
        if (open) {
          walk(it.children ?? [], level + 1, it.value ? [...parents, it.value] : parents)
        }
      }
      else {
        rows.push({ item: it, type: 'link', level, parents, value: (it as TreeListLeafData).value, open: false, forcedOpen: false, posinset: pos, setsize: siblings.length, siblings })
      }
    }
  }
  walk(items, 0, [])
  return rows
}

export function isFocusableRow(row: FlatTreeRow | undefined): boolean {
  return !!row && row.type !== 'header' && row.value !== undefined
}

/** Next focusable row index from `from` in direction `dir` (exclusive), or -1. */
export function stepRow(rows: FlatTreeRow[], from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
    if (isFocusableRow(rows[i])) {
      return i
    }
  }
  return -1
}

export type TreeKeyAction
  = | { type: 'focus', value: string }
    | { type: 'expand', value: string }
    | { type: 'collapse', value: string }
    | { type: 'expandMany', values: string[] }

/**
 * WAI-ARIA APG tree navigation for the row at `index`:
 * ↑/↓ prev/next visible row, Home/End first/last, PageUp/PageDown ±pageSize,
 * → expands a closed branch / enters an open one, ← collapses an open branch /
 * moves to the parent, `*` expands every sibling branch. Returns null when the
 * key does nothing here (activation, typeahead and the context menu are the
 * caller's job).
 */
export function resolveTreeKey(rows: FlatTreeRow[], index: number, key: string, pageSize = 10): TreeKeyAction | null {
  const row = rows[index]
  if (!row) {
    return null
  }
  const focusAt = (i: number): TreeKeyAction | null => {
    const value = rows[i]?.value
    return i !== -1 && i !== index && value !== undefined ? { type: 'focus', value } : null
  }
  switch (key) {
    case 'ArrowDown': {
      return focusAt(stepRow(rows, index, 1))
    }
    case 'ArrowUp': {
      return focusAt(stepRow(rows, index, -1))
    }
    case 'Home': {
      return focusAt(stepRow(rows, -1, 1))
    }
    case 'End': {
      return focusAt(stepRow(rows, rows.length, -1))
    }
    case 'PageDown':
    case 'PageUp': {
      const dir = key === 'PageDown' ? 1 : -1
      const size = Math.max(1, pageSize)
      let target = Math.min(rows.length - 1, Math.max(0, index + dir * size))
      // Land on the focusable row nearest the page target, never past it.
      while (target !== index && !isFocusableRow(rows[target])) {
        target -= dir
      }
      return focusAt(target)
    }
    case 'ArrowRight': {
      if (row.type !== 'collapse' || row.value === undefined) {
        return null
      }
      if (!row.open) {
        return { type: 'expand', value: row.value }
      }
      const next = rows[index + 1]
      return next && next.level > row.level ? focusAt(index + 1) : null
    }
    case 'ArrowLeft': {
      if (row.type === 'collapse' && row.value !== undefined && row.open && !row.forcedOpen) {
        return { type: 'collapse', value: row.value }
      }
      const parent = row.parents.at(-1)
      if (parent === undefined) {
        return null
      }
      const i = rows.findIndex(r => r.value === parent)
      return focusAt(i)
    }
    case '*': {
      const values = row.siblings
        .filter((it): it is TreeListCollapseData => hasChildren(it) && !!it.value)
        .map(it => it.value!)
        .filter((v) => {
          const r = rows.find(x => x.value === v)
          return r !== undefined && !r.open
        })
      return values.length > 0 ? { type: 'expandMany', values } : null
    }
    default: {
      return null
    }
  }
}
