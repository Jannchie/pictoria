// Pure, Vue-free spatial grid navigation for the waterfall gallery.
//
// Extracted verbatim (geometry unchanged) from MainSection.vue's former
// `findNeighborByCoords`, so it can be unit-tested in isolation. The waterfall
// is not a strict grid — rows can be ragged (variable item heights / a short
// last row), so neighbours are found by DOM-rect centre coordinates rather than
// by row/column indices.

export type GridDirection = 'left' | 'right' | 'up' | 'down'

export interface GridRect {
  x: number
  y: number
  width: number
  height: number
}

export interface GridCell {
  id: number
  rect: GridRect
}

/**
 * Given the laid-out cells (in visual/DOM order), the currently focused cell id
 * and a direction, return the id of the cell the focus should move to — or
 * `undefined` when there is no valid neighbour (edge of the grid, focus not in
 * the list, or an empty list).
 *
 * Tie-breaking follows array order: when two candidates score equally the
 * earlier one in `cells` wins (strict `<` comparisons keep the first seen).
 */
export function findGridNeighbor(
  cells: GridCell[],
  focusedId: number,
  direction: GridDirection,
): number | undefined {
  if (cells.length === 0) {
    return undefined
  }
  const curIdx = cells.findIndex(c => c.id === focusedId)
  if (curIdx === -1) {
    return undefined
  }
  const cur = cells[curIdx].rect
  const curCx = cur.x + cur.width / 2
  const curCy = cur.y + cur.height / 2

  if (direction === 'left' || direction === 'right') {
    // Snap to the adjacent column: among candidates strictly on the
    // requested side, find the smallest |dx| (that's the next column),
    // then pick the one with the smallest vertical distance within it.
    const tolerance = Math.max(2, cur.width / 2)
    let minDx = Number.POSITIVE_INFINITY
    for (const [i, cell] of cells.entries()) {
      if (i === curIdx) {
        continue
      }
      const el = cell.rect
      const dx = (el.x + el.width / 2) - curCx
      if (direction === 'left' ? dx < -1 : dx > 1) {
        const abs = Math.abs(dx)
        if (abs < minDx) {
          minDx = abs
        }
      }
    }
    if (!Number.isFinite(minDx)) {
      return undefined
    }
    let best = -1
    let bestDy = Number.POSITIVE_INFINITY
    for (const [i, cell] of cells.entries()) {
      if (i === curIdx) {
        continue
      }
      const el = cell.rect
      const dx = (el.x + el.width / 2) - curCx
      const correctSide = direction === 'left' ? dx < -1 : dx > 1
      if (!correctSide) {
        continue
      }
      if (Math.abs(Math.abs(dx) - minDx) > tolerance) {
        continue
      }
      const dy = Math.abs((el.y + el.height / 2) - curCy)
      if (dy < bestDy) {
        bestDy = dy
        best = i
      }
    }
    return best === -1 ? undefined : cells[best].id
  }

  // Up / down: prefer staying in the same column, but allow nearby columns
  // when there's no overlapping candidate in the current column.
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  for (const [i, cell] of cells.entries()) {
    if (i === curIdx) {
      continue
    }
    const el = cell.rect
    const dx = (el.x + el.width / 2) - curCx
    const dy = (el.y + el.height / 2) - curCy
    if (direction === 'up' ? dy >= -1 : dy <= 1) {
      continue
    }
    const score = Math.abs(dy) + Math.abs(dx) * 2
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best === -1 ? undefined : cells[best].id
}

/**
 * PageUp / PageDown in the masonry: the cell nearest to the point one
 * `pageHeight` above/below the focused cell's centre, preferring the same
 * column (horizontal distance weighs double, like up/down). Only cells
 * strictly on the requested side qualify, so when the page overshoots the
 * end of the grid the move lands on the furthest row instead of doing nothing.
 */
export function findPageTarget(
  cells: GridCell[],
  focusedId: number,
  direction: 'up' | 'down',
  pageHeight: number,
): number | undefined {
  const cur = cells.find(c => c.id === focusedId)?.rect
  if (!cur) {
    return undefined
  }
  const curCx = cur.x + cur.width / 2
  const curCy = cur.y + cur.height / 2
  const targetY = curCy + (direction === 'down' ? pageHeight : -pageHeight)
  let best: number | undefined
  let bestScore = Number.POSITIVE_INFINITY
  for (const cell of cells) {
    if (cell.id === focusedId) {
      continue
    }
    const el = cell.rect
    const cy = el.y + el.height / 2
    const dy = cy - curCy
    if (direction === 'up' ? dy >= -1 : dy <= 1) {
      continue
    }
    const score = Math.abs(cy - targetY) + Math.abs((el.x + el.width / 2) - curCx) * 2
    if (score < bestScore) {
      bestScore = score
      best = cell.id
    }
  }
  return best
}

/** Index of the first rect (in array order) that intersects `[viewTop, viewBottom]`, or -1. */
export function firstVisibleIndex(rects: readonly GridRect[], viewTop: number, viewBottom: number): number {
  return rects.findIndex(r => r.y + r.height > viewTop && r.y < viewBottom)
}

export interface RevealInput {
  /** Item top / height in the scroller's content coordinates. */
  itemTop: number
  itemHeight: number
  /** Current scrollTop and visible height of the scroller. */
  viewTop: number
  viewHeight: number
  /** Breathing room kept between the item and the viewport edge. */
  margin?: number
  /**
   * `nearest`: scroll the minimum amount (like `block: 'nearest'`).
   * `center-if-hidden`: centre the item when it is entirely out of view,
   * otherwise behave like `nearest` (used when returning to a remembered post).
   */
  align?: 'nearest' | 'center-if-hidden'
}

/**
 * The scrollTop that brings an item into view, or `null` when it already is.
 * Pure so off-screen (unrendered, virtualised) cells can be revealed from
 * layout data alone. Items taller than the viewport align to their top.
 */
export function revealScrollTop({ itemTop, itemHeight, viewTop, viewHeight, margin = 0, align = 'nearest' }: RevealInput): number | null {
  const itemBottom = itemTop + itemHeight
  const viewBottom = viewTop + viewHeight
  const clamp = (v: number) => Math.max(0, v)
  if (align === 'center-if-hidden' && (itemBottom <= viewTop || itemTop >= viewBottom)) {
    return clamp(itemTop + itemHeight / 2 - viewHeight / 2)
  }
  const m = Math.max(0, Math.min(margin, (viewHeight - itemHeight) / 2))
  if (itemTop - m < viewTop || itemHeight + 2 * m > viewHeight) {
    return itemTop - m === viewTop ? null : clamp(itemTop - m)
  }
  if (itemBottom + m > viewBottom) {
    return clamp(itemBottom + m - viewHeight)
  }
  return null
}
