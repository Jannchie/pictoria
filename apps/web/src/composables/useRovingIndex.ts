import type { Ref } from 'vue'
import { ref } from 'vue'

/**
 * Pure list-cruise arithmetic shared by keyboard navigation (PMenu DOM-focus
 * cruise and TagSelector hover-index cruise).
 *
 * `current` may be `-1`, meaning "not anchored yet": moving down lands on the
 * first item, moving up lands on the last item. Otherwise the move wraps
 * around the ends. `count` is the list length; callers must guard `count > 0`
 * before calling (an empty list has no valid index to return).
 */
export function nextRovingIndex(current: number, delta: number, count: number): number {
  if (current === -1) {
    return delta > 0 ? 0 : count - 1
  }
  return (current + delta + count) % count
}

/** First selectable index (or -1 when the list is empty). */
export function firstRovingIndex(count: number): number {
  return count > 0 ? 0 : -1
}

/** Last selectable index (or -1 when the list is empty). */
export function lastRovingIndex(count: number): number {
  return count - 1
}

export interface UseRovingIndexOptions {
  /** Current list length, read reactively on every move. */
  count: () => number
  /**
   * Side-effect run after the index changes (e.g. scroll the row into view).
   * Not called when the list is empty.
   */
  onMove?: (index: number) => void
  /**
   * Externally-owned index ref (controlled mode). Useful when the index also
   * drives render highlight and is written by mouse hover. Defaults to an
   * internally-owned ref starting at -1.
   */
  index?: Ref<number>
}

/**
 * Stateful wrapper around {@link nextRovingIndex} for callers that hold a
 * reactive cruise index. Empty lists are a no-op (the index is left as-is).
 */
export function useRovingIndex(options: UseRovingIndexOptions) {
  const { count, onMove } = options
  const index = options.index ?? ref(-1)

  function emit() {
    onMove?.(index.value)
  }

  function move(delta: number) {
    const n = count()
    if (n <= 0) {
      return
    }
    index.value = nextRovingIndex(index.value, delta, n)
    emit()
  }

  function first() {
    const n = count()
    if (n <= 0) {
      return
    }
    index.value = firstRovingIndex(n)
    emit()
  }

  function last() {
    const n = count()
    if (n <= 0) {
      return
    }
    index.value = lastRovingIndex(n)
    emit()
  }

  return { index, move, first, last }
}
