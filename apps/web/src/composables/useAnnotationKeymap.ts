import type { MaybeRefOrGetter } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { toValue } from 'vue'
import { announce } from '@/shared/announce'
import { layerCount } from '@/shared/layers'
import { isAnyDialogOpen } from '@/ui/modal'

/** Keyboard layout for the annotation flow: dimension i uses keyboard row i. */
export const KEY_ROWS: readonly string[][] = [
  ['1', '2', '3', '4', '5'],
  ['q', 'w', 'e', 'r', 't'],
  ['a', 's', 'd', 'f', 'g'],
  ['z', 'x', 'c', 'v', 'b'],
]

export interface KeyChoice { dimension: string, value: number }

export function keyToChoice(key: string, dimensions: string[], scale: number): KeyChoice | null {
  const k = key.toLowerCase()
  for (let row = 0; row < dimensions.length && row < KEY_ROWS.length; row++) {
    const idx = KEY_ROWS[row].indexOf(k)
    if (idx !== -1 && idx < scale) {
      return { dimension: dimensions[row], value: idx + 1 }
    }
  }
  return null
}

/** All keys the absolute annotator listens to. */
export function activeKeys(dimensions: string[], scale: number): string[] {
  return dimensions.flatMap((_, row) => KEY_ROWS[row]?.slice(0, scale) ?? [])
}

export interface ChoiceBinding extends KeyChoice {
  /** A `useHotkey` shortcut: a bare key, so Ctrl+Z / Ctrl+C / Ctrl+A never match it. */
  key: string
}

/**
 * One binding per (dimension row, scale step). Registered as individual shortcuts
 * rather than parsed back out of `e.key`, so layout fallbacks (`e.code`, Caps Lock)
 * in `matchesShortcut` apply and the modifier check is exact.
 */
export function choiceBindings(dimensions: string[], scale: number): ChoiceBinding[] {
  return dimensions.flatMap((dimension, row) =>
    (KEY_ROWS[row]?.slice(0, scale) ?? []).map((key, i) => ({ key, dimension, value: i + 1 })))
}

// ── Sortable list (listwise ranking) ─────────────────────────────────────────

/** Move `list[from]` to index `to` (clamped). Returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list]
  if (from < 0 || from >= next.length) {
    return next
  }
  const target = Math.min(next.length - 1, Math.max(0, to))
  next.splice(target, 0, ...next.splice(from, 1))
  return next
}

export type SortableIntent = 'grab' | 'drop' | 'cancel' | 'prev' | 'next' | 'first' | 'last' | 'view'

interface KeyLike { key: string, altKey: boolean, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, isComposing?: boolean }

/**
 * Keyboard model of one sortable card (APG-style "grab / move / drop").
 *
 * Idle: Space / Enter grab, Alt+↑ / Alt+↓ move directly, V opens the large view.
 * Plain arrows are left to the roving focus of the row (move focus between cards).
 * Grabbed: any arrow moves the card (↑ / ← toward position 1), Home / End to the
 * ends, Space / Enter drop, Escape cancels. Ctrl / Meta / Shift combos are never
 * claimed, so Mod+Enter (submit) and the global undo keep working.
 */
export function sortableIntent(e: KeyLike, grabbed: boolean): SortableIntent | null {
  if (e.isComposing || e.ctrlKey || e.metaKey || e.shiftKey) {
    return null
  }
  const key = e.key
  if (grabbed) {
    if (key === ' ' || key === 'Enter') {
      return 'drop'
    }
    if (key === 'Escape') {
      return 'cancel'
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      return 'prev'
    }
    if (key === 'ArrowDown' || key === 'ArrowRight') {
      return 'next'
    }
    if (key === 'Home') {
      return 'first'
    }
    if (key === 'End') {
      return 'last'
    }
    return null
  }
  if (e.altKey) {
    if (key === 'ArrowUp') {
      return 'prev'
    }
    if (key === 'ArrowDown') {
      return 'next'
    }
    return null
  }
  if (key === ' ' || key === 'Enter') {
    return 'grab'
  }
  if (key.toLowerCase() === 'v') {
    return 'view'
  }
  return null
}

/** Index a move intent lands on, for a list of `count` items. */
export function sortableTarget(intent: 'prev' | 'next' | 'first' | 'last', index: number, count: number): number {
  switch (intent) {
    case 'prev': {
      return Math.max(0, index - 1)
    }
    case 'next': {
      return Math.min(count - 1, index + 1)
    }
    case 'first': {
      return 0
    }
    case 'last': {
      return count - 1
    }
  }
}

// ── Session-wide hotkey guards ───────────────────────────────────────────────

/** Nothing is layered over the session (palette, help, dialogs, the lightbox). */
export function noLayerOpen(): boolean {
  return layerCount.value === 0 && !isAnyDialogOpen.value
}

const FOREIGN_COMPOSITE = '[role=tree], [role=treegrid], [role=listbox], [role=menu], [role=menubar], [role=grid], [role=radiogroup], [role=tablist], [role=slider], [role=spinbutton], input[type=range]'

/**
 * True when focus sits in a composite widget OUTSIDE the session (the sidebar tree,
 * a grid, a menu) — those own their letter / arrow keys, so a session hotkey must
 * not also fire there. Plain buttons elsewhere (the history rows, refresh) do not
 * block: clicking one and then pressing a judging key keeps working.
 */
export function isForeignComposite(target: EventTarget | null, root: HTMLElement | null | undefined): boolean {
  if (!(target instanceof Element) || target === document.body) {
    return false
  }
  if (root?.contains(target)) {
    return false
  }
  return target.closest(FOREIGN_COMPOSITE) !== null
}

/**
 * Debounced polite progress announcement ("12 of 50 annotated"). A burst of fast
 * judgements collapses into the last count instead of queueing one message each.
 */
export function useProgressAnnouncer(message: MaybeRefOrGetter<string>, delay = 800): () => void {
  const fire = useDebounceFn(() => announce(toValue(message)), delay)
  return () => {
    void fire()
  }
}
