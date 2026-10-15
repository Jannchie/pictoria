import type { MaybeRefOrGetter, Ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { getCurrentScope, onScopeDispose, readonly, ref, toValue, watch } from 'vue'
import { isTypingTarget } from '@/utils/keyboard'
import { isTypeaheadKey, matchTypeahead, useTypeahead } from './useTypeahead'

/**
 * DOM roving tabindex for composite widgets (radio groups, toolbars, menus,
 * listboxes, tab lists): the group is ONE Tab stop, arrows move focus inside.
 *
 * Items are the container's descendants matching `itemSelector`. Exactly one
 * of them has `tabindex=0` — the active item — the rest `tabindex=-1`. The
 * default active item is the one with `aria-checked` / `aria-selected` /
 * `aria-current` set (not "false"), else the first enabled one. While focus
 * is outside the group, the active item follows those aria states, so
 * Tabbing in lands on the selected item.
 *
 * Keys handled on the container (skipped when focus is in a text field or a
 * modifier other than Shift is held):
 * - Arrows per `orientation` (horizontal ones are mirrored under `dir=rtl`;
 *   `'both'` maps Left/Up → previous, Right/Down → next),
 * - Home / End, PageUp / PageDown (jump `pageSize`, clamped, no wrap),
 * - printable characters → typeahead when enabled.
 *
 * Disabled = `aria-disabled="true"` or the `disabled` attribute. With
 * `skipDisabled` (default) they are skipped by arrows; with `false` they stay
 * focusable (APG menus keep disabled items focusable so they're announced).
 *
 * Items nested in another roving group inside the container would also
 * match `itemSelector` — give nested groups a distinct selector.
 */

export type RovingOrientation = 'vertical' | 'horizontal' | 'both'

export interface UseRovingFocusOptions {
  container: MaybeRefOrGetter<HTMLElement | null | undefined>
  /** Default `'[data-roving-item]'`. */
  itemSelector?: string
  /** Default `'vertical'`. */
  orientation?: RovingOrientation
  /** Wrap around at the ends. Default `true`. */
  loop?: boolean
  /** Jump to items by typing (label = `data-typeahead` attr, else textContent). Default `false`. */
  typeahead?: boolean
  /** PageUp / PageDown step; `false` leaves those keys alone. Default `10`. */
  pageSize?: number | false
  /** Skip disabled items when moving. Default `true`. */
  skipDisabled?: boolean
  /** Called after focus moved to an item by keyboard or `focusItem`. */
  onMove?: (el: HTMLElement, index: number) => void
}

export interface RovingFocus {
  /** Index of the active item within the current item list (-1 when empty). */
  activeIndex: Readonly<Ref<number>>
  /** Focus item `index` (clamped) and make it the tab stop. */
  focusItem: (index: number) => void
  focusFirst: () => void
  focusLast: () => void
  /** Re-read items and fix tabindex now (normally automatic via MutationObserver). */
  sync: () => void
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')
}

function isMarkedActive(el: HTMLElement): boolean {
  for (const attr of ['aria-checked', 'aria-selected', 'aria-current']) {
    const v = el.getAttribute(attr)
    if (v != null && v !== 'false') {
      return true
    }
  }
  return false
}

/**
 * Index reached by moving `delta` from `from` among `count` items, skipping
 * `blocked` ones. Returns `from` when no allowed item exists in that direction.
 * Exported for tests.
 */
export function stepIndex(
  from: number,
  delta: number,
  count: number,
  blocked: (i: number) => boolean,
  loop: boolean,
): number {
  if (count === 0) {
    return -1
  }
  const dir = delta > 0 ? 1 : -1
  let i = from
  for (let step = 0; step < count; step++) {
    let next = i + dir
    if (next < 0 || next >= count) {
      if (!loop) {
        return from
      }
      next = (next + count) % count
    }
    i = next
    if (!blocked(i)) {
      return i
    }
  }
  return from
}

/**
 * @example
 * const group = useTemplateRef<HTMLElement>('group')
 * useRovingFocus({ container: group, itemSelector: '[role=radio]', orientation: 'horizontal' })
 */
export function useRovingFocus(options: UseRovingFocusOptions): RovingFocus {
  const {
    itemSelector = '[data-roving-item]',
    orientation = 'vertical',
    loop = true,
    typeahead = false,
    pageSize = 10,
    skipDisabled = true,
    onMove,
  } = options
  const activeIndex = ref(-1)
  let activeEl: HTMLElement | null = null
  const ta = useTypeahead()

  const getContainer = () => toValue(options.container) ?? null
  const getItems = (): HTMLElement[] => {
    const c = getContainer()
    return c ? [...c.querySelectorAll<HTMLElement>(itemSelector)] : []
  }
  const blocked = (items: HTMLElement[]) => (i: number) => skipDisabled && isDisabled(items[i])

  function applyTabindex(items: HTMLElement[], active: HTMLElement | null) {
    for (const el of items) {
      const want = el === active ? '0' : '-1'
      if (el.getAttribute('tabindex') !== want) {
        el.setAttribute('tabindex', want)
      }
    }
    activeEl = active
    activeIndex.value = active ? items.indexOf(active) : -1
  }

  function sync() {
    const items = getItems()
    const container = getContainer()
    const focusInside = !!container && container.contains(container.ownerDocument.activeElement)
    const kept = activeEl && items.includes(activeEl) ? activeEl : null
    // While the user is inside the group, never yank the tab stop away from
    // them; otherwise follow the selected / checked / current item.
    const next = (focusInside && kept)
      || items.find(el => isMarkedActive(el) && !(skipDisabled && isDisabled(el)))
      || kept
      || items.find(el => !(skipDisabled && isDisabled(el)))
      || items[0]
      || null
    applyTabindex(items, next)
  }

  function focusItem(index: number) {
    const items = getItems()
    if (items.length === 0) {
      return
    }
    const i = Math.min(Math.max(index, 0), items.length - 1)
    const el = items[i]
    applyTabindex(items, el)
    el.focus()
    onMove?.(el, i)
  }

  function focusFirst() {
    const items = getItems()
    focusItem(stepIndex(-1, 1, items.length, blocked(items), true))
  }

  function focusLast() {
    const items = getItems()
    focusItem(stepIndex(items.length, -1, items.length, blocked(items), true))
  }

  function isRtl(container: HTMLElement): boolean {
    return getComputedStyle(container).direction === 'rtl'
  }

  function deltaFor(key: string, container: HTMLElement): number {
    const vertical = orientation !== 'horizontal'
    const horizontal = orientation !== 'vertical'
    if (vertical && key === 'ArrowUp') {
      return -1
    }
    if (vertical && key === 'ArrowDown') {
      return 1
    }
    if (horizontal && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      const forward = key === 'ArrowRight' ? 1 : -1
      return isRtl(container) ? -forward : forward
    }
    return 0
  }

  function onKeydown(e: KeyboardEvent) {
    const container = getContainer()
    if (!container || e.defaultPrevented || e.isComposing || isTypingTarget(e.target)) {
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return
    }
    const items = getItems()
    if (items.length === 0) {
      return
    }
    const focused = container.ownerDocument.activeElement as HTMLElement | null
    const current = focused ? items.findIndex(el => el === focused || el.contains(focused)) : -1
    const from = current === -1 ? Math.max(0, activeIndex.value) : current
    const isBlocked = blocked(items)
    let target = -1

    const delta = e.shiftKey ? 0 : deltaFor(e.key, container)
    if (delta !== 0) {
      target = stepIndex(from, delta, items.length, isBlocked, loop)
    }
    else if (e.key === 'Home' && !e.shiftKey) {
      target = stepIndex(-1, 1, items.length, isBlocked, true)
    }
    else if (e.key === 'End' && !e.shiftKey) {
      target = stepIndex(items.length, -1, items.length, isBlocked, true)
    }
    else if (pageSize !== false && !e.shiftKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
      const dir = e.key === 'PageDown' ? 1 : -1
      let t = Math.min(Math.max(from + dir * pageSize, 0), items.length - 1)
      if (isBlocked(t)) {
        t = stepIndex(t, -dir, items.length, isBlocked, false)
      }
      target = isBlocked(t) ? from : t
    }
    else if (typeahead && isTypeaheadKey(e, ta.current())) {
      const labels = items.map(el => el.dataset.typeahead ?? el.textContent ?? '')
      const hit = matchTypeahead(labels, ta.push(e.key), current === -1 ? activeIndex.value : current)
      if (hit === -1 || isBlocked(hit)) {
        e.preventDefault()
        return
      }
      target = hit
    }
    else {
      return
    }
    e.preventDefault()
    if (target !== -1) {
      focusItem(target)
    }
  }

  // Clicking / programmatically focusing an item makes it the tab stop.
  function onFocusin(e: FocusEvent) {
    const items = getItems()
    const t = e.target as HTMLElement | null
    const el = t ? items.find(item => item === t || item.contains(t)) : undefined
    if (el && el !== activeEl) {
      applyTabindex(items, el)
    }
  }

  useEventListener(getContainer, 'keydown', onKeydown)
  useEventListener(getContainer, 'focusin', onFocusin)

  // Re-sync on DOM changes, coalesced into one microtask per burst.
  let observer: MutationObserver | undefined
  let queued = false
  const queueSync = () => {
    if (queued) {
      return
    }
    queued = true
    queueMicrotask(() => {
      queued = false
      sync()
    })
  }
  watch(getContainer, (container) => {
    observer?.disconnect()
    observer = undefined
    if (!container) {
      activeEl = null
      activeIndex.value = -1
      return
    }
    sync()
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(queueSync)
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-disabled', 'disabled', 'aria-checked', 'aria-selected', 'aria-current'],
      })
    }
  }, { immediate: true, flush: 'post' })

  if (getCurrentScope()) {
    onScopeDispose(() => observer?.disconnect())
  }

  return { activeIndex: readonly(activeIndex), focusItem, focusFirst, focusLast, sync }
}
