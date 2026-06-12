<script lang="tsx">
import type { PropType, VNode } from 'vue'
import { useVirtualList } from '@vueuse/core'
import { computed, defineComponent, nextTick, watch, watchEffect } from 'vue'
import { formatNumber } from '@/locale'

type Rounded = 'none' | 'sm' | 'md' | 'lg' | 'full'

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

export interface SlotLeafCtx {
  data: TreeListLeafData
  level: number
  isSelected: boolean
  inChain: boolean
  isMatch: boolean
  highlight: (text: string) => any
  count: any
  guides: any
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

const CHEVRON_SLOT = 16
const LEVEL_INDENT = 14

function hasChildren(it: TreeListItemData): it is TreeListCollapseData {
  return 'children' in it && Array.isArray((it as any).children)
}
function isLeaf(it: TreeListItemData): it is TreeListLeafData {
  return 'value' in it && !('children' in it)
}

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
        class={[
          'pointer-events-none absolute top-0 bottom-0 w-px',
          isChainLine ? 'bg-primary/40' : 'bg-border-subtle',
        ]}
        style={{ left: `${10 + i * LEVEL_INDENT}px` }}
      />
    )
  })
}

export default defineComponent({
  name: 'TreeList',
  props: {
    items: { type: Array as PropType<TreeListItemData[]>, required: true },
    rounded: { type: String as PropType<Rounded>, default: 'md' },
    loading: { type: Boolean, default: false },
    loadingRows: { type: Number, default: 7 },
    filter: { type: String, default: '' },
    highlightChain: { type: Array as PropType<string[]>, default: () => [] },
    emptyText: { type: String, default: '没有匹配的目录' },
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

    interface FlatRow {
      item: TreeListItemData
      type: 'link' | 'collapse' | 'header'
      level: number
      parents: string[]
    }
    // The whole visible tree as a flat list — the virtual scroller renders a
    // window of these rows instead of a recursive ul/li tree.
    const visibleRows = computed<FlatRow[]>(() => {
      const rows: FlatRow[] = []
      const walk = (items: TreeListItemData[], level: number, parents: string[]) => {
        for (const it of items) {
          if (!subtreeMatches(it)) {
            continue
          }
          if (isLeaf(it)) {
            if (!filterActive.value || nodeMatches(it)) {
              rows.push({ item: it, type: 'link', level, parents })
            }
          }
          else if (hasChildren(it)) {
            rows.push({ item: it, type: 'collapse', level, parents })
            const isOpen = filterActive.value || (it.value ? props.openPaths.has(it.value) : true)
            if (isOpen) {
              walk(it.children ?? [], level + 1, it.value ? [...parents, it.value] : parents)
            }
          }
          else {
            rows.push({ item: it, type: 'header', level, parents })
          }
        }
      }
      walk(props.items, 0, [])
      return rows
    })

    const heightOf = (row: FlatRow): number =>
      typeof props.itemHeight === 'function' ? props.itemHeight(row.item, row.level) : props.itemHeight

    const { list, containerProps, wrapperProps, scrollTo } = useVirtualList(visibleRows, {
      itemHeight: i => heightOf(visibleRows.value[i]),
      overscan: 12,
    })

    const rowValue = (row: FlatRow | undefined): string | undefined =>
      row && 'value' in row.item ? row.item.value : undefined

    function focusValue(value: string) {
      const idx = visibleRows.value.findIndex(r => rowValue(r) === value)
      if (idx !== -1) {
        scrollTo(idx)
      }
      nextTick(() => {
        const el = containerProps.ref.value?.querySelector(`[data-tree-value="${CSS.escape(value)}"]`) as HTMLElement | null
        el?.focus()
      })
    }

    function onRootKeydown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const value = target?.dataset?.treeValue
      if (!value) {
        return
      }
      const rows = visibleRows.value
      const idx = rows.findIndex(r => rowValue(r) === value)
      if (idx === -1) {
        return
      }
      const row = rows[idx]
      // Headers carry no value — step over them when navigating.
      const focusable = (from: number, dir: 1 | -1): string | undefined => {
        for (let i = from + dir; i >= 0 && i < rows.length; i += dir) {
          const v = rowValue(rows[i])
          if (v) {
            return v
          }
        }
        return undefined
      }
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          const v = focusable(idx, 1)
          if (v) {
            focusValue(v)
          }
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          const v = focusable(idx, -1)
          if (v) {
            focusValue(v)
          }
          break
        }
        case 'Home': {
          e.preventDefault()
          const v = focusable(-1, 1)
          if (v) {
            focusValue(v)
          }
          break
        }
        case 'End': {
          e.preventDefault()
          const v = focusable(rows.length, -1)
          if (v) {
            focusValue(v)
          }
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          if (row.type === 'collapse') {
            if (props.openPaths.has(value)) {
              const next = rows[idx + 1]
              const v = rowValue(next)
              if (next && next.level > row.level && v) {
                focusValue(v)
              }
            }
            else {
              setOpen(value, true)
              nextTick(() => focusValue(value))
            }
          }
          break
        }
        case 'ArrowLeft': {
          e.preventDefault()
          if (row.type === 'collapse' && props.openPaths.has(value)) {
            setOpen(value, false)
          }
          else if (row.parents.length > 0) {
            focusValue(row.parents.at(-1)!)
          }
          break
        }
        case 'Enter': {
          e.preventDefault()
          if (row.type === 'collapse') {
            emit('update:modelValue', value)
            setOpen(value, true)
          }
          else {
            emit('update:modelValue', value)
          }
          break
        }
      }
    }

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
            'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums transition-colors',
            selected ? 'bg-primary/15 text-primary' : 'text-fg-subtle group-hover/row:text-fg-muted',
          ]}
        >
          {formatNumber(n)}
        </span>
      )
    }

    const ROW_BASE = 'group/row relative h-8 w-full flex items-center gap-1.5 pr-1 text-sm transition-colors focus-visible:[outline-offset:-2px] cursor-pointer'

    function LeafDefault(item: TreeListLeafData, level: number, isSelected: boolean, inChain: boolean) {
      return (
        <a
          tabindex={0}
          data-tree-value={item.value}
          title={item.title}
          class={[
            ROW_BASE,
            roundedClass.value,
            isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
          ]}
          style={indentStyle(level)}
          onClick={() => emit('update:modelValue', item.value)}
          onContextmenu={(e: MouseEvent) => {
            e.preventDefault()
            emit('itemContext', { data: item, event: e })
          }}
          {...item.attrs}
        >
          {guidesFor(level, inChain)}
          {isSelected && <span class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute" />}
          {item.icon && <i class={['h-3.5 w-3.5 shrink-0', item.icon as string]} />}
          {highlight(item.title)}
          {countNode(item.count, isSelected)}
        </a>
      )
    }

    function CollapseDefault(item: TreeListCollapseData, level: number, isOpen: boolean, isSelected: boolean, inChain: boolean) {
      return (
        <button
          type="button"
          tabindex={0}
          data-tree-value={item.value ?? ''}
          title={item.title}
          class={[
            ROW_BASE,
            roundedClass.value,
            'text-left',
            isSelected ? 'text-fg bg-primary/10' : 'text-fg-muted hover:bg-surface-1 hover:text-fg',
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
          onContextmenu={(e: MouseEvent) => {
            e.preventDefault()
            emit('itemContext', { data: item, event: e })
          }}
        >
          {guidesFor(level, inChain)}
          {isSelected && <span class="rounded-r-full bg-primary w-[2px] pointer-events-none bottom-1.5 left-0 top-1.5 absolute" />}
          <i
            class={[
              'i-tabler-chevron-down h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform',
              isOpen ? 'rotate-0' : '-rotate-90',
            ]}
            style={{ marginLeft: `-${CHEVRON_SLOT - 2}px` }}
          />
          {item.icon && <i class={['h-3.5 w-3.5 shrink-0', item.icon as string]} />}
          {highlight(item.title)}
          {countNode(item.count, isSelected)}
        </button>
      )
    }

    function HeaderDefault(item: TreeListHeaderData, level: number) {
      return (
        <div
          class="text-xs text-fg-subtle tracking-wider font-semibold flex gap-1 h-7 uppercase items-center"
          style={indentStyle(level)}
        >
          {item.icon && <i class={['h-3 w-3', item.icon as string]} />}
          <span class="truncate">{item.title}</span>
        </div>
      )
    }

    // Render one flattened row (no recursion — the virtual list owns the
    // flat sequence; subtree expansion is reflected by visibleRows).
    function renderRow(row: FlatRow): any {
      const { item, level, type } = row
      if (type === 'link') {
        const leaf = item as TreeListLeafData
        const isSelected = props.modelValue === leaf.value
        const inChain = chainSet.value.has(leaf.value)
        const ctx: SlotLeafCtx = {
          data: leaf,
          level,
          isSelected,
          inChain,
          isMatch: nodeMatches(item),
          highlight,
          count: countNode(leaf.count, isSelected),
          guides: guidesFor(level, inChain),
        }
        return slots.link ? slots.link(ctx) : LeafDefault(leaf, level, isSelected, inChain)
      }
      if (type === 'collapse') {
        const coll = item as TreeListCollapseData
        const isOpenComputed = filterActive.value ? true : (coll.value ? props.openPaths.has(coll.value) : true)
        const isSelected = !!coll.value && props.modelValue === coll.value
        const inChain = !!coll.value && chainSet.value.has(coll.value)
        const ctx: SlotCollapseCtx = {
          data: coll,
          level,
          isOpen: isOpenComputed,
          isSelected,
          inChain,
          isMatch: nodeMatches(coll),
          toggle: () => toggle(coll.value),
          highlight,
          count: countNode(coll.count, isSelected),
          guides: guidesFor(level, inChain),
        }
        return slots.collapse ? slots.collapse(ctx) : CollapseDefault(coll, level, isOpenComputed, isSelected, inChain)
      }
      return slots.header
        ? slots.header({ data: item as TreeListHeaderData, level })
        : HeaderDefault(item as TreeListHeaderData, level)
    }

    expose({ focusValue, setOpen, toggle })

    return () => {
      if (props.loading) {
        return (
          <ul class="px-2 py-1 flex flex-col gap-1.5">
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
          <div class="text-xs text-fg-subtle px-3 py-8 flex flex-col gap-2 items-center justify-center">
            <i class="i-tabler-folder-search h-6 w-6" />
            <span>{props.emptyText}</span>
          </div>
        )
      }
      return (
        <div
          ref={containerProps.ref}
          class="text-sm h-full overflow-y-auto"
          style={containerProps.style}
          role="tree"
          onKeydown={onRootKeydown}
          onScroll={containerProps.onScroll}
        >
          <div style={wrapperProps.value.style}>
            {list.value.map(({ data: row, index }) => (
              <div
                key={rowValue(row) ?? `row-${index}`}
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
