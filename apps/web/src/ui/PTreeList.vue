<script lang="tsx">
import type { PropType } from 'vue'
import type { FlatTreeRow, TreeListCollapseData, TreeListHeaderData, TreeListItemData, TreeListLeafData } from './treeListModel'
import { useVirtualList } from '@vueuse/core'
import { computed, defineComponent, nextTick, onBeforeUpdate, onUpdated, ref, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { isTypeaheadKey, matchTypeahead, useTypeahead } from '@/composables/useTypeahead'
import { formatNumber } from '@/locale'
import { flattenTree, hasChildren, isFocusableRow, resolveTreeKey } from './treeListModel'

export type { TreeListCollapseData, TreeListHeaderData, TreeListItemData, TreeListLeafData } from './treeListModel'

type Rounded = 'none' | 'sm' | 'md' | 'lg' | 'full'

/**
 * ARIA attributes + roving tabindex for one tree row. Slots MUST bind this
 * object onto the row's single focusable element (`v-bind="itemProps"`) —
 * role, keyboard focus and `data-tree-value` all live on the same element.
 */
export interface TreeItemProps {
  'role': 'treeitem'
  'aria-level': number
  'aria-setsize': number
  'aria-posinset': number
  'aria-selected': 'true' | undefined
  'aria-expanded': 'true' | 'false' | undefined
  'tabindex': 0 | -1
  'data-tree-value': string | undefined
}

export interface SlotLeafCtx {
  data: TreeListLeafData
  level: number
  isSelected: boolean
  inChain: boolean
  isMatch: boolean
  highlight: (text: string) => any
  count: any
  guides: any
  itemProps: TreeItemProps
}
export interface SlotCollapseCtx {
  data: TreeListCollapseData
  level: number
  isOpen: boolean
  isSelected: boolean
  inChain: boolean
  isMatch: boolean
  toggle: () => void
  highlight: (text: string) => any
  count: any
  guides: any
  itemProps: TreeItemProps
}
export interface SlotHeaderCtx {
  data: TreeListHeaderData
  level: number
}

const RADIUS: Record<Rounded, string> = {
  none: 'rounded-none',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  full: 'rounded-full',
}

export const CHEVRON_SLOT = 16
export const LEVEL_INDENT = 14

function indentStyle(level: number) {
  return { paddingLeft: `${CHEVRON_SLOT + level * LEVEL_INDENT}px` }
}

function guidesFor(level: number, inChain: boolean) {
  if (level <= 0) {
    return null
  }
  return Array.from({ length: level }, (_, i) => {
    const isChainLine = inChain && i === level - 1
    return (
      <span
        key={i}
        aria-hidden="true"
        class={[
          'pointer-events-none absolute top-0 bottom-0 w-px',
          isChainLine ? 'bg-primary/40' : 'bg-border-subtle',
        ]}
        style={{ left: `${10 + i * LEVEL_INDENT}px` }}
      />
    )
  })
}

/**
 * Virtualised WAI-ARIA tree (APG "tree view", flat rows with aria-level /
 * aria-setsize / aria-posinset).
 *
 * Keyboard: one Tab stop (roving tabindex on the "cursor" row); ↑↓ Home End
 * PageUp PageDown move; → expands / enters, ← collapses / goes to parent;
 * Enter and Space activate the row (a native `click`, so RouterLink rows
 * navigate); `*` expands all siblings; printable characters typeahead on the
 * row titles; Shift+F10 / ContextMenu are left to the browser, which fires
 * `contextmenu` on the focused row (→ `itemContext`).
 *
 * Virtualisation: rows scrolled out of the window unmount. If the focused row
 * goes, focus parks on the tree container (which carries the cursor's
 * `data-tree-value`, so keys keep working from it) and moves back onto the row
 * as soon as it renders again. While the cursor row isn't rendered, the
 * container itself is the Tab stop and Tab-ing onto it scrolls the row back.
 */
export default defineComponent({
  name: 'TreeList',
  props: {
    items: { type: Array as PropType<TreeListItemData[]>, required: true },
    rounded: { type: String as PropType<Rounded>, default: 'md' },
    loading: { type: Boolean, default: false },
    loadingRows: { type: Number, default: 7 },
    filter: { type: String, default: '' },
    highlightChain: { type: Array as PropType<string[]>, default: () => [] },
    /** Empty-state text; defaults to the (i18n) "no matching folders". */
    emptyText: { type: String, default: undefined },
    /** Accessible name of the tree (role=tree needs one). */
    ariaLabel: { type: String, default: undefined },
    modelValue: { type: String, default: undefined },
    openPaths: { type: Object as PropType<Set<string>>, default: () => new Set<string>() },
    // Row height (px) for the virtual scroller — a number, or a function of
    // the item + level when rows differ (e.g. folders with a stats line).
    // Must match what the slot actually renders, or rows overlap/jump.
    itemHeight: {
      type: [Number, Function] as PropType<number | ((item: TreeListItemData, level: number) => number)>,
      default: 36,
    },
  },
  emits: {
    'update:modelValue': (_v?: string) => true,
    'update:openPaths': (_v: Set<string>) => true,
    'itemContext': (_p: { data: TreeListLeafData | TreeListCollapseData, event: MouseEvent }) => true,
  },
  setup(props, { emit, slots, expose }) {
    const { t } = useI18n()
    const roundedClass = computed(() => RADIUS[props.rounded])
    const filterLower = computed(() => props.filter.trim().toLowerCase())
    const filterActive = computed(() => filterLower.value.length > 0)
    const chainSet = computed(() => new Set(props.highlightChain))

    function nodeMatches(item: TreeListItemData): boolean {
      if (!filterActive.value) {
        return true
      }
      if (!('title' in item)) {
        return false
      }
      return item.title.toLowerCase().includes(filterLower.value)
    }
    function subtreeMatches(item: TreeListItemData): boolean {
      if (!filterActive.value) {
        return true
      }
      if (nodeMatches(item)) {
        return true
      }
      if (hasChildren(item)) {
        return (item.children ?? []).some(subtreeMatches)
      }
      return false
    }

    function setOpenPaths(next: Set<string>) {
      emit('update:openPaths', next)
    }

    // Seed from items[].open on first non-empty render so callers can express
    // a default-open set declaratively. After the seed the state lives in
    // openPaths and input-data mutations are ignored.
    let seeded = false
    watchEffect(() => {
      if (seeded || props.items.length === 0) {
        return
      }
      const next = new Set(props.openPaths)
      const walk = (item: TreeListItemData) => {
        if (hasChildren(item)) {
          if (item.open && item.value) {
            next.add(item.value)
          }
          for (const child of item.children ?? []) {
            walk(child)
          }
        }
      }
      for (const item of props.items) {
        walk(item)
      }
      seeded = true
      if (next.size !== props.openPaths.size) {
        setOpenPaths(next)
      }
    })

    // While filtering, auto-expand any ancestor with a matching descendant.
    watch([filterActive, () => props.items], () => {
      if (!filterActive.value) {
        return
      }
      const next = new Set(props.openPaths)
      const walk = (item: TreeListItemData) => {
        if (hasChildren(item)) {
          const hit = (item.children ?? []).some(subtreeMatches)
          if (hit && item.value) {
            next.add(item.value)
          }
          for (const child of item.children ?? []) {
            walk(child)
          }
        }
      }
      for (const item of props.items) {
        walk(item)
      }
      if (next.size !== props.openPaths.size) {
        setOpenPaths(next)
      }
    }, { immediate: true })

    function setOpen(value: string, open: boolean) {
      if (props.openPaths.has(value) === open) {
        return
      }
      const next = new Set(props.openPaths)
      if (open) {
        next.add(value)
      }
      else {
        next.delete(value)
      }
      setOpenPaths(next)
    }
    function toggle(value?: string) {
      if (!value) {
        return
      }
      setOpen(value, !props.openPaths.has(value))
    }

    // The whole visible tree as a flat list — the virtual scroller renders a
    // window of these rows instead of a recursive ul/li tree.
    const visibleRows = computed<FlatTreeRow[]>(() => flattenTree(props.items, {
      keep: subtreeMatches,
      isOpen: v => props.openPaths.has(v),
      forceOpen: filterActive.value,
    }))
    const rowIndex = computed(() => {
      const map = new Map<string, number>()
      for (const [i, row] of visibleRows.value.entries()) {
        if (isFocusableRow(row)) {
          map.set(row.value!, i)
        }
      }
      return map
    })

    const heightOf = (row: FlatTreeRow): number =>
      typeof props.itemHeight === 'function' ? props.itemHeight(row.item, row.level) : props.itemHeight

    const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(visibleRows, {
      itemHeight: i => heightOf(visibleRows.value[i]),
      overscan: 12,
    })
    const containerEl = containerProps.ref

    // ── Cursor (the roving tab stop) ────────────────────────────────────────
    // `cursor` is the row the user last focused. When it disappears (a branch
    // above it collapsed, the filter hid it, the folder was deleted) the tab
    // stop falls back to its nearest visible ancestor, then the selected row,
    // then the first row.
    const cursor = ref<string | null>(null)
    let cursorParents: string[] = []
    const activeValue = computed<string | undefined>(() => {
      const index = rowIndex.value
      if (cursor.value !== null && index.has(cursor.value)) {
        return cursor.value
      }
      for (let i = cursorParents.length - 1; i >= 0; i--) {
        if (index.has(cursorParents[i])) {
          return cursorParents[i]
        }
      }
      if (props.modelValue !== undefined && index.has(props.modelValue)) {
        return props.modelValue
      }
      return visibleRows.value.find(isFocusableRow)?.value
    })
    function setCursor(value: string) {
      cursor.value = value
      const i = rowIndex.value.get(value)
      cursorParents = i === undefined ? [] : visibleRows.value[i].parents
    }
    const activeRendered = computed(() =>
      activeValue.value !== undefined && list.value.some(({ data }) => data.value === activeValue.value),
    )

    function focusInside(): boolean {
      const el = containerEl.value
      return !!el && el.contains(document.activeElement)
    }

    // Tab stop follows the selection while focus is elsewhere (APG).
    watch(() => props.modelValue, (value) => {
      if (value !== undefined && !focusInside()) {
        cursor.value = value
        cursorParents = []
      }
    })

    function rowEl(value: string | undefined): HTMLElement | null {
      if (value === undefined) {
        return null
      }
      return containerEl.value?.querySelector<HTMLElement>(`[data-tree-value="${CSS.escape(value)}"]`) ?? null
    }

    let parking = false
    function focusValue(value: string) {
      setCursor(value)
      const el = rowEl(value)
      if (el) {
        el.focus({ preventScroll: true })
        el.scrollIntoView?.({ block: 'nearest' })
        return
      }
      const idx = rowIndex.value.get(value)
      if (idx !== undefined) {
        scrollTo(idx)
      }
      nextTick(() => {
        rowEl(value)?.focus({ preventScroll: true })
      })
    }

    // Keep keyboard focus alive across virtual-list re-renders (see the
    // component doc comment).
    let rowHadFocus = false
    onBeforeUpdate(() => {
      const el = containerEl.value
      rowHadFocus = !!el && el !== document.activeElement && el.contains(document.activeElement)
    })
    onUpdated(() => {
      const el = containerEl.value
      if (!el) {
        return
      }
      const active = document.activeElement
      const lost = !active || active === document.body || !active.isConnected
      if (rowHadFocus && lost) {
        const row = rowEl(activeValue.value)
        if (row) {
          row.focus({ preventScroll: true })
        }
        else {
          parking = true
          el.focus({ preventScroll: true })
          parking = false
        }
      }
      else if (active === el) {
        rowEl(activeValue.value)?.focus({ preventScroll: true })
      }
      rowHadFocus = false
    })

    function onFocusin(e: FocusEvent) {
      const target = e.target as HTMLElement | null
      const el = containerEl.value
      if (!target || !el) {
        return
      }
      if (target !== el) {
        const value = target.dataset.treeValue
        if (value !== undefined && target.getAttribute('role') === 'treeitem') {
          setCursor(value)
        }
        return
      }
      if (parking) {
        return
      }
      // Focus landed on the container itself (Tab, or a click on empty space):
      // hand it to the cursor row, scrolling it back if it is virtualised away.
      const value = activeValue.value
      if (value === undefined) {
        return
      }
      const row = rowEl(value)
      if (row) {
        row.focus({ preventScroll: true })
      }
      else if (!el.contains(e.relatedTarget as Node | null)) {
        focusValue(value)
      }
    }

    // ── Keyboard ────────────────────────────────────────────────────────────
    const typeahead = useTypeahead()

    function activate(value: string, e: KeyboardEvent) {
      const el = rowEl(value)
      if (!el) {
        return
      }
      // Enter on a real link is the browser's own activation (RouterLink
      // navigates, modifier keys keep working); everything else gets a click.
      if (e.key === 'Enter' && e.target === el && el.matches('a[href]')) {
        return
      }
      e.preventDefault()
      el.click()
    }

    function onRootKeydown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) {
        return
      }
      const el = containerEl.value
      const target = e.target as HTMLElement | null
      if (!el || !target) {
        return
      }
      let value: string | undefined
      if (target === el) {
        value = activeValue.value
      }
      else if (target.getAttribute('role') === 'treeitem') {
        value = target.dataset.treeValue
      }
      if (value === undefined) {
        return
      }
      const rows = visibleRows.value
      const idx = rowIndex.value.get(value)
      if (idx === undefined) {
        return
      }

      if (e.key === 'Enter' || (e.key === ' ' && typeahead.current() === '')) {
        activate(value, e)
        return
      }
      if (e.key !== '*' && isTypeaheadKey(e, typeahead.current())) {
        e.preventDefault()
        const focusable = rows.filter(isFocusableRow)
        const labels = focusable.map(r => ('title' in r.item ? r.item.title : ''))
        const at = matchTypeahead(labels, typeahead.push(e.key), focusable.findIndex(r => r.value === value))
        if (at !== -1) {
          focusValue(focusable[at].value!)
        }
        return
      }
      if (e.shiftKey && e.key !== '*') {
        return
      }
      const pageSize = Math.max(1, Math.floor(el.clientHeight / Math.max(1, heightOf(rows[idx]))) - 1)
      const action = resolveTreeKey(rows, idx, e.key, pageSize)
      if (!action) {
        // Swallow the tree's own navigation keys even when they are no-ops at
        // the edge, so they never fall through to page scrolling / hotkeys.
        if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', '*'].includes(e.key)) {
          e.preventDefault()
        }
        return
      }
      e.preventDefault()
      switch (action.type) {
        case 'focus': {
          focusValue(action.value)
          break
        }
        case 'expand': {
          setOpen(action.value, true)
          break
        }
        case 'collapse': {
          setOpen(action.value, false)
          break
        }
        case 'expandMany': {
          const next = new Set(props.openPaths)
          for (const v of action.values) {
            next.add(v)
          }
          setOpenPaths(next)
          break
        }
      }
    }

    // ── Rendering ───────────────────────────────────────────────────────────
    function highlight(text: string) {
      if (!filterActive.value) {
        return <span class="truncate">{text}</span>
      }
      const lower = text.toLowerCase()
      const idx = lower.indexOf(filterLower.value)
      if (idx === -1) {
        return <span class="truncate">{text}</span>
      }
      const end = idx + filterLower.value.length
      return (
        <span class="truncate">
          {text.slice(0, idx)}
          <mark class="text-fg px-0.5 rounded-sm bg-primary/30">{text.slice(idx, end)}</mark>
          {text.slice(end)}
        </span>
      )
    }

    function countNode(n: number | undefined, selected: boolean) {
      if (n == null) {
        return null
      }
      return (
        <span
          class={[
            'ml-auto shrink-0 pl-1.5 text-[10px] font-mono tabular-nums transition-colors',
            selected ? 'text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
          ]}
        >
          {formatNumber(n)}
        </span>
      )
    }

    function itemPropsOf(row: FlatTreeRow, isSelected: boolean): TreeItemProps {
      return {
        'role': 'treeitem',
        'aria-level': row.level + 1,
        'aria-setsize': row.setsize,
        'aria-posinset': row.posinset,
        'aria-selected': isSelected ? 'true' : undefined,
        'aria-expanded': row.type === 'collapse' ? (row.open ? 'true' : 'false') : undefined,
        'tabindex': row.value !== undefined && row.value === activeValue.value ? 0 : -1,
        'data-tree-value': row.value,
      }
    }

    function onRowContext(item: TreeListLeafData | TreeListCollapseData, e: MouseEvent) {
      e.preventDefault()
      emit('itemContext', { data: item, event: e })
    }

    const ROW_BASE = 'group/row relative h-8 w-full flex items-center gap-1.5 pr-1 text-sm transition-colors focus-visible:[outline-offset:-2px] cursor-pointer'

    function LeafDefault(item: TreeListLeafData, level: number, isSelected: boolean, inChain: boolean, itemProps: TreeItemProps) {
      return (
        <div
          {...item.attrs}
          {...itemProps}
          title={item.title}
          class={[
            ROW_BASE,
            roundedClass.value,
            isSelected ? 'text-fg bg-primary/10 hover:bg-primary/15' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
          ]}
          style={indentStyle(level)}
          onClick={() => emit('update:modelValue', item.value)}
          onContextmenu={(e: MouseEvent) => onRowContext(item, e)}
        >
          {guidesFor(level, inChain)}
          {item.icon && <i aria-hidden="true" class={['h-3.5 w-3.5 shrink-0', item.icon as string]} />}
          {highlight(item.title)}
          {countNode(item.count, isSelected)}
        </div>
      )
    }

    function CollapseDefault(item: TreeListCollapseData, level: number, isOpen: boolean, isSelected: boolean, inChain: boolean, itemProps: TreeItemProps) {
      return (
        <div
          {...itemProps}
          title={item.title}
          class={[
            ROW_BASE,
            roundedClass.value,
            'text-left',
            isSelected ? 'text-fg bg-primary/10 hover:bg-primary/15' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
          ]}
          style={indentStyle(level)}
          onClick={() => {
            if (item.value) {
              if (props.modelValue === item.value && isOpen) {
                setOpen(item.value, false)
              }
              else {
                emit('update:modelValue', item.value)
                setOpen(item.value, true)
              }
            }
            else {
              toggle(item.value)
            }
          }}
          onContextmenu={(e: MouseEvent) => onRowContext(item, e)}
        >
          {guidesFor(level, inChain)}
          <i
            aria-hidden="true"
            class={[
              'i-tabler-chevron-down h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform',
              isOpen ? 'rotate-0' : '-rotate-90',
            ]}
            style={{ marginLeft: `-${CHEVRON_SLOT - 2}px` }}
          />
          {item.icon && <i aria-hidden="true" class={['h-3.5 w-3.5 shrink-0', item.icon as string]} />}
          {highlight(item.title)}
          {countNode(item.count, isSelected)}
        </div>
      )
    }

    function HeaderDefault(item: TreeListHeaderData, level: number) {
      return (
        <div
          class="text-xs text-fg-subtle tracking-wider font-semibold flex gap-1 h-7 uppercase items-center"
          style={indentStyle(level)}
        >
          {item.icon && <i aria-hidden="true" class={['h-3 w-3', item.icon as string]} />}
          <span class="truncate">{item.title}</span>
        </div>
      )
    }

    // Render one flattened row (no recursion — the virtual list owns the
    // flat sequence; subtree expansion is reflected by visibleRows).
    function renderRow(row: FlatTreeRow): any {
      const { item, level, type } = row
      if (type === 'link') {
        const leaf = item as TreeListLeafData
        const isSelected = props.modelValue === leaf.value
        const inChain = chainSet.value.has(leaf.value)
        const itemProps = itemPropsOf(row, isSelected)
        const ctx: SlotLeafCtx = {
          data: leaf,
          level,
          isSelected,
          inChain,
          isMatch: nodeMatches(item),
          highlight,
          count: countNode(leaf.count, isSelected),
          guides: guidesFor(level, inChain),
          itemProps,
        }
        return slots.link ? slots.link(ctx) : LeafDefault(leaf, level, isSelected, inChain, itemProps)
      }
      if (type === 'collapse') {
        const coll = item as TreeListCollapseData
        const isSelected = !!coll.value && props.modelValue === coll.value
        const inChain = !!coll.value && chainSet.value.has(coll.value)
        const itemProps = itemPropsOf(row, isSelected)
        const ctx: SlotCollapseCtx = {
          data: coll,
          level,
          isOpen: row.open,
          isSelected,
          inChain,
          isMatch: nodeMatches(coll),
          toggle: () => toggle(coll.value),
          highlight,
          count: countNode(coll.count, isSelected),
          guides: guidesFor(level, inChain),
          itemProps,
        }
        return slots.collapse ? slots.collapse(ctx) : CollapseDefault(coll, level, row.open, isSelected, inChain, itemProps)
      }
      return slots.header
        ? slots.header({ data: item as TreeListHeaderData, level })
        : HeaderDefault(item as TreeListHeaderData, level)
    }

    /** Move keyboard focus into the tree (onto the cursor row). */
    function focus() {
      const value = activeValue.value
      if (value !== undefined) {
        focusValue(value)
      }
    }

    expose({ focusValue, focus, setOpen, toggle })

    return () => {
      if (props.loading) {
        return (
          <ul class="px-2 py-1 flex flex-col gap-1.5" aria-busy="true" aria-label={props.ariaLabel}>
            {Array.from({ length: props.loadingRows }, (_, i) => (
              <li
                key={i}
                class="rounded bg-surface-1 h-6 animate-pulse"
                style={{ width: `${60 + ((i * 17) % 35)}%`, animationDelay: `${i * 60}ms` }}
              />
            ))}
          </ul>
        )
      }
      if (visibleRows.value.length === 0) {
        return (
          <div role="status" class="text-xs text-fg-subtle px-3 py-8 flex flex-col gap-2 items-center justify-center">
            <i aria-hidden="true" class="i-tabler-folder-search h-6 w-6" />
            <span>{props.emptyText ?? t('sidebar.noFolderMatch')}</span>
          </div>
        )
      }
      return (
        <div
          ref={containerProps.ref}
          class="text-sm h-full overflow-y-auto focus-visible:[outline-offset:-2px]"
          style={containerProps.style}
          role="tree"
          aria-label={props.ariaLabel}
          tabindex={activeRendered.value ? -1 : 0}
          data-tree-value={activeValue.value}
          onKeydown={onRootKeydown}
          onFocusin={onFocusin}
          onScroll={containerProps.onScroll}
        >
          <div role="none" style={wrapperProps.value.style}>
            {list.value.map(({ data: row, index }) => (
              <div
                key={row.value ?? `row-${index}`}
                role="none"
                class="list-none relative"
                style={{ height: `${heightOf(row)}px` }}
              >
                {renderRow(row)}
              </div>
            ))}
          </div>
        </div>
      )
    }
  },
})
</script>
