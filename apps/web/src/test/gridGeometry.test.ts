import type { GridCell, GridDirection } from '@/utils/gridGeometry'
import { describe, expect, it } from 'vitest'
import { findGridNeighbor } from '@/utils/gridGeometry'

// Helper: build a cell with a rect. Default item is 100x100.
function cell(id: number, x: number, y: number, width = 100, height = 100): GridCell {
  return { id, rect: { x, y, width, height } }
}

// A regular 3x3 grid. Columns at x = 0, 120, 240; rows at y = 0, 120, 240.
// Ids are row-major:
//   0 1 2
//   3 4 5
//   6 7 8
const regularGrid: GridCell[] = [
  cell(0, 0, 0),
  cell(1, 120, 0),
  cell(2, 240, 0),
  cell(3, 0, 120),
  cell(4, 120, 120),
  cell(5, 240, 120),
  cell(6, 0, 240),
  cell(7, 120, 240),
  cell(8, 240, 240),
]

describe('findgridneighbor — regular grid, four directions from the centre', () => {
  const cases: Array<[GridDirection, number]> = [
    ['left', 3],
    ['right', 5],
    ['up', 1],
    ['down', 7],
  ]
  for (const [direction, expected] of cases) {
    it(`moves ${direction} from the centre (id 4) to id ${expected}`, () => {
      expect(findGridNeighbor(regularGrid, 4, direction)).toBe(expected)
    })
  }
})

describe('findgridneighbor — grid edges have no neighbour', () => {
  it('row start: left from a first-column cell does not move', () => {
    expect(findGridNeighbor(regularGrid, 3, 'left')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 0, 'left')).toBeUndefined()
  })

  it('row end: right from a last-column cell does not move', () => {
    expect(findGridNeighbor(regularGrid, 5, 'right')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 2, 'right')).toBeUndefined()
  })

  it('first row: up does not move', () => {
    expect(findGridNeighbor(regularGrid, 0, 'up')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 1, 'up')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 2, 'up')).toBeUndefined()
  })

  it('last row: down does not move', () => {
    expect(findGridNeighbor(regularGrid, 6, 'down')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 7, 'down')).toBeUndefined()
    expect(findGridNeighbor(regularGrid, 8, 'down')).toBeUndefined()
  })
})

describe('findgridneighbor — horizontal snaps to the adjacent column (tolerance)', () => {
  it('right from a first-column cell picks the immediate next column, not a far one', () => {
    // From id 0, both id 1 (dx=120) and id 2 (dx=240) are on the right; the
    // tolerance (max(2, width/2)=50) keeps only the nearest column (id 1).
    expect(findGridNeighbor(regularGrid, 0, 'right')).toBe(1)
  })

  it('left from a last-column cell picks the immediate previous column', () => {
    expect(findGridNeighbor(regularGrid, 2, 'left')).toBe(1)
  })
})

describe('findgridneighbor — ragged last row (fewer, centred items)', () => {
  // Two full rows of 3, then a short last row of 2 centred items.
  //   0(0)   1(120)   2(240)
  //   3(0)   4(120)   5(240)
  //      6(60)   7(180)
  const raggedGrid: GridCell[] = [
    cell(0, 0, 0),
    cell(1, 120, 0),
    cell(2, 240, 0),
    cell(3, 0, 120),
    cell(4, 120, 120),
    cell(5, 240, 120),
    cell(6, 60, 240),
    cell(7, 180, 240),
  ]

  it('down from a full row lands on the nearest ragged item, ties resolve to array order', () => {
    // id 4 (cx=170): id 6 (cx=110, dx=-60) and id 7 (cx=230, dx=60) tie on
    // score; the earlier one in the array (id 6) wins.
    expect(findGridNeighbor(raggedGrid, 4, 'down')).toBe(6)
  })

  it('down from a corner lands on the closest ragged item', () => {
    expect(findGridNeighbor(raggedGrid, 5, 'down')).toBe(7)
    expect(findGridNeighbor(raggedGrid, 3, 'down')).toBe(6)
  })

  it('up from a ragged item lands on the nearest full-row cell', () => {
    // id 6 (cx=110): id 3 (cx=50, dx=-60) and id 4 (cx=170, dx=60) tie; id 3 wins.
    expect(findGridNeighbor(raggedGrid, 6, 'up')).toBe(3)
  })

  it('an isolated two-item row navigates horizontally between its items', () => {
    const row: GridCell[] = [cell(6, 60, 240), cell(7, 180, 240)]
    expect(findGridNeighbor(row, 6, 'right')).toBe(7)
    expect(findGridNeighbor(row, 7, 'left')).toBe(6)
    expect(findGridNeighbor(row, 7, 'right')).toBeUndefined()
    expect(findGridNeighbor(row, 6, 'left')).toBeUndefined()
  })

  it('horizontal from a ragged item snaps to the nearest column centre, even diagonally', () => {
    // id 6 (cx=110): the nearest centre on the right is id 4 (cx=170, dx=60),
    // not the same-row id 7 (cx=230, dx=120) — the tolerance keeps only the
    // closest column. This pins the existing (misalignment-sensitive) behaviour.
    expect(findGridNeighbor(raggedGrid, 6, 'right')).toBe(4)
  })
})

describe('findgridneighbor — vertical falls back to a nearby column', () => {
  it('down reaches an offset column when nothing sits directly below', () => {
    // id 0 has no cell in its own column below it; id 1 sits below-and-right.
    const grid: GridCell[] = [cell(0, 0, 0), cell(1, 120, 120)]
    expect(findGridNeighbor(grid, 0, 'down')).toBe(1)
    expect(findGridNeighbor(grid, 1, 'up')).toBe(0)
  })
})

describe('findgridneighbor — single column', () => {
  const column: GridCell[] = [cell(0, 0, 0), cell(1, 0, 120), cell(2, 0, 240)]

  it('up/down step through the column', () => {
    expect(findGridNeighbor(column, 0, 'down')).toBe(1)
    expect(findGridNeighbor(column, 1, 'down')).toBe(2)
    expect(findGridNeighbor(column, 2, 'up')).toBe(1)
    expect(findGridNeighbor(column, 1, 'up')).toBe(0)
  })

  it('left/right never leave a single column', () => {
    expect(findGridNeighbor(column, 1, 'left')).toBeUndefined()
    expect(findGridNeighbor(column, 1, 'right')).toBeUndefined()
  })

  it('the ends do not move past the column', () => {
    expect(findGridNeighbor(column, 0, 'up')).toBeUndefined()
    expect(findGridNeighbor(column, 2, 'down')).toBeUndefined()
  })
})

describe('findgridneighbor — degenerate inputs', () => {
  it('returns undefined for an empty list', () => {
    for (const direction of ['left', 'right', 'up', 'down'] as GridDirection[]) {
      expect(findGridNeighbor([], 0, direction)).toBeUndefined()
    }
  })

  it('returns undefined when the focused id is not in the list', () => {
    for (const direction of ['left', 'right', 'up', 'down'] as GridDirection[]) {
      expect(findGridNeighbor(regularGrid, 999, direction)).toBeUndefined()
    }
  })

  it('returns undefined for a single-item list in every direction', () => {
    const one: GridCell[] = [cell(0, 0, 0)]
    for (const direction of ['left', 'right', 'up', 'down'] as GridDirection[]) {
      expect(findGridNeighbor(one, 0, direction)).toBeUndefined()
    }
  })
})
