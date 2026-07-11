import { beforeEach, describe, expect, it } from 'vitest'
import {
  addToSelection,
  clear,
  collapseSelectionTo,
  commitPendingSelection,
  effectiveSelectedIds,
  isCommittedSelected,
  isSelected,
  selectAll,
  selectedCount,
  selectedIdList,
  selectOnly,
  soleSelectedId,
  toggle,
  togglePendingAt,
  updatePendingSelection,
} from '@/shared/selection'

// Read helpers: the module state lives at module scope, so assert through the
// public computeds.
function committed(): number[] {
  return [...selectedIdList.value].sort((a, b) => a - b)
}
function effective(): number[] {
  return [...effectiveSelectedIds.value].filter((id): id is number => typeof id === 'number').sort((a, b) => a - b)
}

// Reset all three internal layers using only the public API: commit folds the
// transient layers away and empties them, then clear empties the committed set.
function resetSelection() {
  commitPendingSelection()
  clear()
}

beforeEach(() => {
  resetSelection()
})

describe('committed selection verbs', () => {
  it('selectonly replaces the whole selection with one id', () => {
    selectAll([1, 2, 3])
    selectOnly(9)
    expect(committed()).toEqual([9])
  })

  it('selectall replaces the selection with exactly the given ids', () => {
    selectOnly(1)
    selectAll([4, 5, 6])
    expect(committed()).toEqual([4, 5, 6])
  })

  it('clear empties the selection', () => {
    selectAll([1, 2])
    clear()
    expect(committed()).toEqual([])
    expect(selectedCount.value).toBe(0)
  })

  it('addtoselection adds one id and is idempotent', () => {
    selectOnly(1)
    addToSelection(2)
    expect(committed()).toEqual([1, 2])
    addToSelection(2)
    expect(committed()).toEqual([1, 2])
  })

  const toggleCases: { name: string, seed: number[], toggles: number[], expected: number[] }[] = [
    { name: 'adds an unselected id', seed: [1], toggles: [2], expected: [1, 2] },
    { name: 'removes a selected id', seed: [1, 2], toggles: [1], expected: [2] },
    { name: 'add then remove is a no-op', seed: [1], toggles: [2, 2], expected: [1] },
  ]
  for (const { name, seed, toggles, expected } of toggleCases) {
    it(`toggle ${name}`, () => {
      selectAll(seed)
      for (const id of toggles) {
        toggle(id)
      }
      expect(committed()).toEqual(expected)
    })
  }
})

describe('collapseselectionto (plain pointer-up)', () => {
  it('collapses a multi-selection to the clicked, already-selected id', () => {
    selectAll([1, 2, 3])
    collapseSelectionTo(2)
    expect(committed()).toEqual([2])
  })

  it('does nothing when the clicked id is not selected', () => {
    selectAll([1, 2])
    collapseSelectionTo(9)
    expect(committed()).toEqual([1, 2])
  })

  it('does not collapse when a drag-box just staged the id (in selecting)', () => {
    selectAll([1, 2])
    // Shift-drag re-adds 1 into the transient selecting layer.
    updatePendingSelection([1], { shift: true, ctrl: false })
    collapseSelectionTo(1)
    expect(committed()).toEqual([1, 2])
  })
})

describe('drag-box pending selection', () => {
  it('plain mode replaces the pending hits as the box moves', () => {
    updatePendingSelection([1, 2], { shift: false, ctrl: false })
    expect(effective()).toEqual([1, 2])
    updatePendingSelection([3], { shift: false, ctrl: false })
    expect(effective()).toEqual([3])
  })

  it('shift mode unions hits and never shrinks', () => {
    updatePendingSelection([1], { shift: true, ctrl: false })
    updatePendingSelection([2], { shift: true, ctrl: false })
    // Dragging back over nothing keeps the accumulated hits.
    updatePendingSelection([2], { shift: true, ctrl: false })
    expect(effective()).toEqual([1, 2])
  })

  it('ctrl mode removes committed hits and adds uncommitted ones', () => {
    selectAll([1, 2])
    // 2 is committed -> staged for removal; 3 is new -> staged for addition.
    updatePendingSelection([2, 3], { shift: false, ctrl: true })
    expect(effective()).toEqual([1, 3])
    expect(isSelected(2)).toBe(false)
  })

  it('commit folds the transient layers into the committed selection', () => {
    updatePendingSelection([1, 2], { shift: true, ctrl: false })
    commitPendingSelection()
    expect(committed()).toEqual([1, 2])
    // Transients are cleared: the effective set equals the committed set.
    expect(effective()).toEqual([1, 2])
  })
})

describe('togglependingat (shift click)', () => {
  it('stages an unselected id for addition', () => {
    togglePendingAt(5)
    expect(isSelected(5)).toBe(true)
    commitPendingSelection()
    expect(committed()).toEqual([5])
  })

  it('a second shift click on the same id stages it for removal', () => {
    togglePendingAt(5)
    togglePendingAt(5)
    expect(isSelected(5)).toBe(false)
    commitPendingSelection()
    expect(committed()).toEqual([])
  })

  it('shift click on a committed id stages it for removal', () => {
    selectOnly(5)
    togglePendingAt(5)
    expect(isSelected(5)).toBe(false)
    commitPendingSelection()
    expect(committed()).toEqual([])
  })
})

describe('the effective-selection invariant', () => {
  // effective = (committed ∪ selecting) ∖ unselected — unselected wins over both.
  it('unselected takes priority over committed and selecting', () => {
    selectAll([1, 2])
    // ctrl-drag over [2,3]: 2 (committed) -> unselected, 3 -> selecting.
    updatePendingSelection([2, 3], { shift: false, ctrl: true })
    expect(effective()).toEqual([1, 3])
    expect(isSelected(1)).toBe(true)
    expect(isSelected(2)).toBe(false)
    expect(isSelected(3)).toBe(true)
    commitPendingSelection()
    expect(committed()).toEqual([1, 3])
  })
})

describe('committed read helpers', () => {
  it('iscommittedselected reflects only the committed layer', () => {
    selectAll([1])
    updatePendingSelection([2], { shift: true, ctrl: false })
    expect(isCommittedSelected(1)).toBe(true)
    // 2 is only in the transient layer, not yet committed.
    expect(isCommittedSelected(2)).toBe(false)
    expect(isSelected(2)).toBe(true)
  })

  const soleCases: { name: string, ids: number[], expected: number | undefined }[] = [
    { name: 'single selection', ids: [7], expected: 7 },
    { name: 'multi selection', ids: [1, 2], expected: undefined },
    { name: 'empty selection', ids: [], expected: undefined },
  ]
  for (const { name, ids, expected } of soleCases) {
    it(`soleselectedid: ${name}`, () => {
      selectAll(ids)
      expect(soleSelectedId.value).toBe(expected)
      expect(selectedCount.value).toBe(ids.length)
    })
  }
})
