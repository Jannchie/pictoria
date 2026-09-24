import type { ComputedRef, InjectionKey, MaybeRefOrGetter, Ref } from 'vue'
import type { GridMoveMode } from '@/shared/selection'
import type { GridCell, GridDirection, GridRect } from '@/utils/gridGeometry'
import { useDebounceFn, useEventListener, usePreferredReducedMotion } from '@vueuse/core'
import { computed, provide, reactive, ref, toValue, watch, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { handleHotkey } from '@/composables/useHotkey'
import { announce } from '@/shared/announce'
import { layerCount } from '@/shared/layers'
import {
  clear as clearSelection,
  extendToGridCursor,
  gridCursorId,
  isCommittedSelected,
  moveGridCursor,
  selectAll,
  selectedCount,
  selectedIdList,
  selectOnly,
  setGridCursor,
  soleSelectedId,
  toggleGridCursor,
} from '@/shared/selection'
import { shortcuts } from '@/shared/shortcuts'
import { findGridNeighbor, findPageTarget, firstVisibleIndex, revealScrollTop } from '@/utils/gridGeometry'

/**
 * The gallery grid as ONE keyboard composite (APG listbox, multi-select).
 *
 * vue-wf only renders the thumbnails near the viewport, so DOM focus cannot
 * live on a thumbnail (it would fall to <body> the moment it scrolls away).
 * Focus stays on the listbox container; the logical cursor is exposed through
 * `aria-activedescendant` (only while that thumbnail is actually rendered) and
 * drawn as a ring on the thumbnail via the injected context. Every move is
 * computed from the layout data, so off-screen targets are scrolled to first
 * and pick up the ring once vue-wf renders them.
 */

export interface GalleryGridContext {
  /** Draw the cursor ring (grid focused and the last input was the keyboard). */
  showCursor: Readonly<Ref<boolean>>
  /** Rendered thumbnails report in/out so aria-activedescendant never dangles. */
  register: (id: number) => void
  unregister: (id: number) => void
}

export const galleryGridKey: InjectionKey<GalleryGridContext> = Symbol('galleryGrid')

/** DOM id of a thumbnail — the aria-activedescendant target. */
export function gridItemDomId(id: number): string {
  return `post-item-${id}`
}

/** Marks a gallery listbox, so page-level hotkeys can recognise it as "the grid" rather than a foreign widget. */
export const GALLERY_GRID_ATTR = 'data-gallery-grid'

/**
 * Put keyboard focus on the gallery grid (its focus handler shows / seeds the
 * cursor). For actions in a side panel that replace the panel's own content
 * under focus — the focused button is about to vanish and focus would fall
 * to <body>. Returns false when no grid is on the page.
 */
export function focusGalleryGrid(): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const grid = document.querySelector<HTMLElement>(`[${GALLERY_GRID_ATTR}]`)
  if (!grid) {
    return false
  }
  grid.focus({ preventScroll: true })
  return document.activeElement === grid
}

export interface UseGalleryGridOptions {
  /** The listbox element (the Waterfall wrapper). */
  container: MaybeRefOrGetter<HTMLElement | null | undefined>
  /** The element that scrolls the grid. */
  scroller: MaybeRefOrGetter<HTMLElement | null | undefined>
  /** Post ids in list order. */
  ids: Readonly<Ref<readonly number[]>>
  /** Waterfall layout rects, index-aligned with `ids` (relative to the container). */
  layout: MaybeRefOrGetter<readonly GridRect[] | undefined>
  /** Grid keys are live only while this is true (key scope, dialogs…). */
  enabled?: MaybeRefOrGetter<boolean>
  /** Enter: open this post. */
  open: (id: number) => void
  /** Delete: ask to delete the selection. Omit to leave Delete to the page. */
  requestDelete?: () => void
  /** Shift+F10 / ContextMenu: open the context menu for the cursor item. */
  contextMenu?: boolean
  /** After the cursor moved by keyboard (e.g. drop a stale ?post_id). */
  onMove?: () => void
}

export interface GalleryGrid {
  /** Keyboard handler for events whose target is outside the grid (body, non-widgets). Returns true when handled. */
  handleOutsideKey: (e: KeyboardEvent) => boolean
  /** Scroll `id` into view from layout data alone (works for unrendered cells). */
  reveal: (id: number, options?: { align?: 'nearest' | 'center-if-hidden', smooth?: boolean }) => void
  /** Move DOM focus onto the grid container without scrolling. */
  focusGrid: () => void
  /** Cursor ring currently drawn. */
  showCursor: ComputedRef<boolean>
}

const ARROWS: Record<string, GridDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}
type Target = GridDirection | 'home' | 'end' | 'pageUp' | 'pageDown'
const NAV_KEYS: Record<string, Target> = {
  ...ARROWS,
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
}

/** `[shortcut, target, mode]` — every nav key × {plain, Shift, Mod, Mod+Shift}. */
function navBindings(keys: readonly string[]): [string, string, GridMoveMode][] {
  const out: [string, string, GridMoveMode][] = []
  for (const key of keys) {
    out.push(
      [key, key, 'select'],
      [`Shift+${key}`, key, 'extend'],
      [`Mod+Shift+${key}`, key, 'extend'],
      [`Mod+${key}`, key, 'focus'],
    )
  }
  return out
}
const INSIDE_NAV = navBindings(Object.keys(NAV_KEYS))
// From outside the grid (focus on <body>) only the keys the grid always
// answered to: arrows. Home/End/Page keys stay with the page there.
const OUTSIDE_NAV = navBindings(Object.keys(ARROWS))
// Bindings come from the shortcut catalogue (the help sheet reads the same
// entries). Ctrl+Space also toggles on a Mac, where Mod is Cmd.
const KEYS = shortcuts.gallery
const TOGGLE_KEYS = [...KEYS.toggle.keys, 'Ctrl+Space']
const DELETE_KEYS = KEYS.deleteSelected.keys
const MENU_KEYS = KEYS.contextMenu.keys
const REVEAL_MARGIN = 16

/** Container top in the scroller's content coordinates. */
function containerOffset(scroller: HTMLElement, container: HTMLElement): number {
  return container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

/** Fire a contextmenu at the centre of `target` (so a menu host anchors there). */
function dispatchMenuAt(target: HTMLElement) {
  const rect = target.getBoundingClientRect()
  // Centre of the visible part, so a tall / half-hidden item still anchors on screen.
  const left = Math.max(rect.left, 0)
  const right = Math.min(rect.right, window.innerWidth)
  const top = Math.max(rect.top, 0)
  const bottom = Math.min(rect.bottom, window.innerHeight)
  target.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    ctrlKey: true,
    clientX: Math.round((left + right) / 2),
    clientY: Math.round((top + bottom) / 2),
  }))
}

export function useGalleryGrid(options: UseGalleryGridOptions): GalleryGrid {
  const { t } = useI18n()
  const reducedMotion = usePreferredReducedMotion()
  const enabled = () => toValue(options.enabled) ?? true
  const containerEl = () => toValue(options.container) ?? null

  // ── Rendered thumbnails ──────────────────────────────────────────────────
  const rendered = reactive(new Set<number>())
  const focused = ref(false)
  const keyboardActive = ref(false)
  const showCursor = computed(() => focused.value && keyboardActive.value)
  provide(galleryGridKey, {
    showCursor,
    register: id => rendered.add(id),
    unregister: id => rendered.delete(id),
  })

  const activeDescendant = computed(() => {
    const id = gridCursorId.value
    return id !== null && rendered.has(id) ? gridItemDomId(id) : undefined
  })
  // Set imperatively: binding it on <Waterfall> would re-render the whole
  // waterfall on every cursor move.
  watchEffect(() => {
    const el = containerEl()
    const id = activeDescendant.value
    if (!el) {
      return
    }
    if (id) {
      el.setAttribute('aria-activedescendant', id)
    }
    else {
      el.removeAttribute('aria-activedescendant')
    }
  }, { flush: 'post' })

  // ── Geometry ─────────────────────────────────────────────────────────────
  function cells(): GridCell[] {
    const layout = toValue(options.layout) ?? []
    const ids = options.ids.value
    const out: GridCell[] = []
    for (const [i, rect] of layout.entries()) {
      const id = ids[i]
      if (id !== undefined) {
        out.push({ id, rect })
      }
    }
    return out
  }

  function reveal(id: number, { align = 'nearest', smooth = false }: { align?: 'nearest' | 'center-if-hidden', smooth?: boolean } = {}) {
    const scroller = toValue(options.scroller)
    const container = containerEl()
    const index = options.ids.value.indexOf(id)
    const rect = (toValue(options.layout) ?? [])[index]
    if (!scroller || !container || !rect) {
      return
    }
    const top = revealScrollTop({
      itemTop: containerOffset(scroller, container) + rect.y,
      itemHeight: rect.height,
      viewTop: scroller.scrollTop,
      viewHeight: scroller.clientHeight,
      margin: REVEAL_MARGIN,
      align,
    })
    if (top !== null) {
      scroller.scrollTo({ top, behavior: smooth && reducedMotion.value !== 'reduce' ? 'smooth' : 'auto' })
    }
  }

  function focusGrid() {
    containerEl()?.focus({ preventScroll: true })
  }

  /** The id moves start from: the cursor, else the first selected item in list order. */
  function currentId(): number | null {
    const ids = options.ids.value
    const c = gridCursorId.value
    if (c !== null && ids.includes(c)) {
      return c
    }
    return ids.find(id => isCommittedSelected(id)) ?? null
  }

  function resolveTarget(kind: Target): number | undefined {
    const ids = options.ids.value
    if (ids.length === 0) {
      return undefined
    }
    if (kind === 'home') {
      return ids[0]
    }
    if (kind === 'end') {
      return ids.at(-1)
    }
    const from = currentId()
    if (from === null) {
      // Nothing to start from: enter at the corner the key points away from.
      return kind === 'right' || kind === 'down' || kind === 'pageDown' ? ids[0] : ids.at(-1)
    }
    const all = cells()
    if (kind === 'pageUp' || kind === 'pageDown') {
      const pageHeight = toValue(options.scroller)?.clientHeight ?? 0
      return findPageTarget(all, from, kind === 'pageUp' ? 'up' : 'down', Math.max(1, pageHeight - 2 * REVEAL_MARGIN))
    }
    return findGridNeighbor(all, from, kind)
  }

  function move(key: string, mode: GridMoveMode, e: KeyboardEvent) {
    const kind = NAV_KEYS[key]
    const target = kind ? resolveTarget(kind) : undefined
    if (target === undefined) {
      return
    }
    moveGridCursor(options.ids.value, target, mode)
    keyboardActive.value = true
    options.onMove?.()
    reveal(target, { smooth: !e.repeat })
  }

  function openCurrent() {
    const id = currentId() ?? soleSelectedId.value
    if (id !== undefined && id !== null) {
      options.open(id)
    }
  }

  // ── Context menu (Shift+F10 / ContextMenu key) ───────────────────────────
  // Keyboard-opened menus are re-dispatched as a contextmenu event on the
  // cursor thumbnail, at its centre, so the menu host anchors to that item —
  // not to the grid-sized focused container. `ctrlKey` keeps PostItem's
  // right-click handler from collapsing a multi-selection.
  let suppressNativeMenuUntil = 0
  function openContextMenu() {
    const container = containerEl()
    if (!container) {
      return
    }
    suppressNativeMenuUntil = performance.now() + 1000
    const id = currentId()
    if (id === null) {
      dispatchMenuAt(container)
      return
    }
    if (!isCommittedSelected(id)) {
      selectOnly(id)
      setGridCursor(id)
    }
    const find = () => container.querySelector<HTMLElement>(`#${gridItemDomId(id)}`)
    const item = find()
    if (item) {
      dispatchMenuAt(item)
      return
    }
    // Scrolled away from the cursor: bring it back, let vue-wf render it, then open.
    reveal(id)
    requestAnimationFrame(() => requestAnimationFrame(() => dispatchMenuAt(find() ?? container)))
  }

  // The browser's own keyboard contextmenu lands on the focused container.
  // Swallow it right after we opened ours; otherwise (a key we didn't see)
  // redirect it to the cursor item.
  useEventListener(() => containerEl() ?? undefined, 'contextmenu', (e: MouseEvent) => {
    if (!options.contextMenu || !e.isTrusted || e.target !== containerEl()) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    if (performance.now() < suppressNativeMenuUntil) {
      suppressNativeMenuUntil = 0
      return
    }
    openContextMenu()
  }, { capture: true })

  // ── Keys ─────────────────────────────────────────────────────────────────
  function handleInsideKey(e: KeyboardEvent): boolean {
    if (!enabled()) {
      return false
    }
    // Focus is on the listbox itself (a widget), so widget targets are allowed
    // here; typing targets never occur inside the grid.
    const opts = { allowInWidgets: true }
    for (const [shortcut, key, mode] of INSIDE_NAV) {
      if (handleHotkey(e, shortcut, ev => move(key, mode, ev), opts)) {
        return true
      }
    }
    return handleHotkey(e, TOGGLE_KEYS, () => {
      ensureCursor()
      toggleGridCursor()
      keyboardActive.value = true
    }, { ...opts, repeat: false })
    || handleHotkey(e, KEYS.rangeToCursor.keys, () => {
      ensureCursor()
      extendToGridCursor(options.ids.value)
      keyboardActive.value = true
    }, { ...opts, repeat: false })
    || handleHotkey(e, KEYS.openPost.keys, openCurrent, { ...opts, repeat: false })
    || handleHotkey(e, KEYS.selectAll.keys, () => selectAll(options.ids.value), opts)
    || handleHotkey(e, KEYS.clearSelection.keys, clearSelection, { ...opts, when: () => selectedCount.value > 0 })
    || (options.requestDelete !== undefined
      && handleHotkey(e, DELETE_KEYS, () => options.requestDelete?.(), { ...opts, repeat: false }))
    || (options.contextMenu === true
      && handleHotkey(e, MENU_KEYS, openContextMenu, { ...opts, repeat: false }))
  }

  function handleOutsideKey(e: KeyboardEvent): boolean {
    // While a popover / menu / dialog is open, keys that reach the page belong
    // to it (e.g. arrows on a popover panel that has no options yet) — the
    // grid must not pull focus out from under it.
    if (!enabled() || layerCount.value > 0) {
      return false
    }
    // Default guards: text fields and foreign widgets (buttons, sliders, tree
    // rows…) keep their own keys.
    for (const [shortcut, key, mode] of OUTSIDE_NAV) {
      if (handleHotkey(e, shortcut, (ev) => {
        // Focus first (its handler may seed the cursor), then move from there.
        focusGrid()
        move(key, mode, ev)
      })) {
        return true
      }
    }
    return handleHotkey(e, KEYS.openPost.keys, openCurrent, { repeat: false })
      || handleHotkey(e, KEYS.selectAll.keys, () => selectAll(options.ids.value))
      || (options.requestDelete !== undefined
        && handleHotkey(e, DELETE_KEYS, () => options.requestDelete?.(), { repeat: false }))
  }

  useEventListener(() => containerEl() ?? undefined, 'keydown', (e: KeyboardEvent) => {
    if (e.target !== containerEl()) {
      return
    }
    handleInsideKey(e)
  })

  // ── Focus & input modality ───────────────────────────────────────────────
  let pointerFocus = false
  useEventListener(() => containerEl() ?? undefined, 'pointerdown', () => {
    pointerFocus = true
    keyboardActive.value = false
  }, { capture: true })

  /** Give a freshly focused grid a cursor: first selected, else first visible, else first. */
  function ensureCursor() {
    const ids = options.ids.value
    const c = gridCursorId.value
    if (ids.length === 0 || (c !== null && ids.includes(c))) {
      return
    }
    const selected = ids.find(id => isCommittedSelected(id))
    if (selected !== undefined) {
      setGridCursor(selected)
      return
    }
    const scroller = toValue(options.scroller)
    const container = containerEl()
    let index = 0
    if (scroller && container) {
      const top = scroller.scrollTop - containerOffset(scroller, container)
      index = Math.max(0, firstVisibleIndex(toValue(options.layout) ?? [], top, top + scroller.clientHeight))
    }
    setGridCursor(ids[index] ?? ids[0])
  }

  useEventListener(() => containerEl() ?? undefined, 'focus', () => {
    focused.value = true
    keyboardActive.value = !pointerFocus
    pointerFocus = false
    if (keyboardActive.value) {
      ensureCursor()
      const c = gridCursorId.value
      if (c !== null) {
        reveal(c)
      }
    }
  })
  useEventListener(() => containerEl() ?? undefined, 'blur', () => {
    focused.value = false
    pointerFocus = false
  })

  // ── Live selection count ─────────────────────────────────────────────────
  // One announcer for the count (BottomBar's counter is deliberately not a
  // live region, so it isn't read twice). Debounced: holding Shift+↓ reads
  // the final count once.
  const announceCount = useDebounceFn((n: number) => {
    announce(t('gallery.selectionAnnounce', { n }, n))
  }, 500)
  // A count dropping to 0 is only read while the grid has focus — a clear
  // caused elsewhere (post-to-post navigation) would just be noise.
  watch(() => selectedIdList.value.length, (n, old) => {
    if (n !== old && (n > 0 || focused.value)) {
      void announceCount(n)
    }
  })

  return { handleOutsideKey, reveal, focusGrid, showCursor }
}
