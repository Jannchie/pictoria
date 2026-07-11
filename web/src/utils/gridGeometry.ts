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
