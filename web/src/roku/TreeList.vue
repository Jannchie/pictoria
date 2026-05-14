<script lang="tsx">
import type { PropType, VNode } from 'vue'
import { computed, defineComponent, nextTick, ref, watch, watchEffect } from 'vue'
import AutoHeightTransition from './AutoHeightTransition.vue'

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

    const rootRef = ref<HTMLUListElement | null>(null)

    interface FlatRow {
      value: string
      type: 'link' | 'collapse'
      level: number
      parents: string[]
    }
    function flatten(): FlatRow[] {
      const rows: FlatRow[] = []
      const walk = (items: TreeListItemData[], level: number, parents: string[]) => {
        for (const it of items) {
          if (!subtreeMatches(it)) {
            continue
          }
          if (isLeaf(it)) {
            rows.push({ value: it.value, type: 'link', level, parents })
          }
          else if (hasChildren(it)) {
            if (it.value) {
              rows.push({ value: it.value, type: 'collapse', level, parents })
            }
            const isOpen = filterActive.value || (it.value ? props.openPaths.has(it.value) : true)
            if (isOpen) {
              walk(it.children ?? [], level + 1, it.value ? [...parents, it.value] : parents)
            }
          }
        }
      }
      walk(props.items, 0, [])
      return rows
    }
    function focusValue(value: string) {
      if (!rootRef.value) {
        return
      }
      const el = rootRef.value.querySelector(`[data-tree-value="${CSS.escape(value)}"]`) as HTMLElement | null
      el?.focus()
    }

    function onRootKeydown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const value = target?.dataset?.treeValue
      if (!value) {
        return
      }
      const rows = flatten()
      const idx = rows.findIndex(r => r.value === value)
      if (idx === -1) {
        return
      }
      const row = rows[idx]
      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault()
          if (idx < rows.length - 1) {
            focusValue(rows[idx + 1].value)
          }
          break
        }
        case 'ArrowUp': {
          e.preventDefault()
          if (idx > 0) {
            focusValue(rows[idx - 1].value)
          }
          break
        }
        case 'Home': {
          e.preventDefault()
          if (rows.length > 0) {
            focusValue(rows[0].value)
          }
          break
        }
        case 'End': {
          e.preventDefault()
          if (rows.length > 0) {
            focusValue(rows.at(-1)!.value)
          }
          break
        }
        case 'ArrowRight': {
          e.preventDefault()
          if (row.type === 'collapse') {
            if (props.openPaths.has(value)) {
              const next = rows[idx + 1]
              if (next && next.level > row.level) {
                focusValue(next.value)
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
          {Intl.NumberFormat('en-US').format(n)}
        </span>
      )
    }

    const ROW_BASE = 'group/row relative h-8 w-full flex items-center gap-1.5 pr-1 text-sm transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/50 cursor-pointer'

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

    function renderItem(item: TreeListItemData, level: number): any {
      if (isLeaf(item)) {
        if (filterActive.value && !nodeMatches(item)) {
          return null
        }
        const isSelected = props.modelValue === item.value
        const inChain = chainSet.value.has(item.value)
        const ctx: SlotLeafCtx = {
          data: item,
          level,
          isSelected,
          inChain,
          isMatch: nodeMatches(item),
          highlight,
          count: countNode(item.count, isSelected),
          guides: guidesFor(level, inChain),
        }
        return (
          <li class="list-none relative">
            {slots.link ? slots.link(ctx) : LeafDefault(item, level, isSelected, inChain)}
          </li>
        )
      }
      if (hasChildren(item)) {
        if (!subtreeMatches(item)) {
          return null
        }
        const isOpenComputed = filterActive.value
          ? true
          : (item.value ? props.openPaths.has(item.value) : true)
        const isSelected = !!item.value && props.modelValue === item.value
        const inChain = !!item.value && chainSet.value.has(item.value)
        const ctx: SlotCollapseCtx = {
          data: item,
          level,
          isOpen: isOpenComputed,
          isSelected,
          inChain,
          isMatch: nodeMatches(item),
          toggle: () => toggle(item.value),
          highlight,
          count: countNode(item.count, isSelected),
          guides: guidesFor(level, inChain),
        }
        return (
          <li class="list-none relative">
            {slots.collapse ? slots.collapse(ctx) : CollapseDefault(item, level, isOpenComputed, isSelected, inChain)}
            <AutoHeightTransition>
              {isOpenComputed && (
                <ul class="transition-height overflow-hidden">
                  {(item.children ?? []).map(child => renderItem(child, level + 1))}
                </ul>
              )}
            </AutoHeightTransition>
          </li>
        )
      }
      return (
        <li class="list-none">
          {slots.header ? slots.header({ data: item, level }) : HeaderDefault(item, level)}
        </li>
      )
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
      const visible = filterActive.value ? props.items.filter(subtreeMatches) : props.items
      if (visible.length === 0) {
        return (
          <div class="text-xs text-fg-subtle px-3 py-8 flex flex-col gap-2 items-center justify-center">
            <i class="i-tabler-folder-search h-6 w-6" />
            <span>{props.emptyText}</span>
          </div>
        )
      }
      return (
        <ul
          ref={rootRef}
          class="text-sm flex flex-col"
          role="tree"
          onKeydown={onRootKeydown}
        >
          {visible.map(item => renderItem(item, 0))}
        </ul>
      )
    }
  },
})
</script>
