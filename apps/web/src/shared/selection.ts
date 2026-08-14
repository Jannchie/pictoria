import { computed, ref } from 'vue'

// The single home for post-selection state. Three private Set refs back the
// selection; nothing outside this module touches them. Read the selection
// through the exported computeds/predicates, mutate it through the verbs.
//
// - `committed`   the confirmed selection (what survives between gestures).
// - `selecting`   ids being added by an in-flight gesture (drag-box / shift).
// - `unselected`  ids being removed by an in-flight gesture (drag-box / shift).
//
// The effective selection the user sees is (committed ∪ selecting) ∖ unselected.
// That invariant is expressed once, in `effectiveSelectedIds` / `isSelected`,
// and nowhere else. A gesture writes to `selecting`/`unselected` while it runs
// and folds them back into `committed` on commit.
const committed = ref<Set<number | undefined>>(new Set())
const selecting = ref<Set<number | undefined>>(new Set())
const unselected = ref<Set<number | undefined>>(new Set())

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

// (committed ∪ selecting) ∖ unselected — the live selection including any
// in-flight gesture. This is the only place the invariant is computed.
export const effectiveSelectedIds = computed<Set<number | undefined>>(() => {
  const out = new Set(committed.value)
  for (const id of selecting.value) {
    out.add(id)
  }
  for (const id of unselected.value) {
    out.delete(id)
  }
  return out
})

// Effective membership (mirrors `effectiveSelectedIds`), used for the grid
// item's selected outline where the drag-box preview must show live.
export function isSelected(id: number | undefined): boolean {
  return (committed.value.has(id) || selecting.value.has(id)) && !unselected.value.has(id)
}

// Committed membership — excludes the in-flight gesture. Detail-page styling
// and side-panel intersection read this so they stay steady during a drag.
export function isCommittedSelected(id: number | undefined): boolean {
  return committed.value.has(id)
}

// Size of the committed selection.
export const selectedCount = computed<number>(() => committed.value.size)

// Committed ids narrowed to numbers — what every batch action iterates.
export const selectedIdList = computed<number[]>(() =>
  [...committed.value].filter((id): id is number => typeof id === 'number'),
)

// The sole committed id when exactly one post is selected and it is a real
// numeric id; otherwise undefined (which also covers the >1 and 0 cases).
export const soleSelectedId = computed<number | undefined>(() => {
  if (committed.value.size !== 1) {
    return
  }
  const only = committed.value.values().next().value
  return typeof only === 'number' ? only : undefined
})

// ---------------------------------------------------------------------------
// Write API — committed selection
// ---------------------------------------------------------------------------

// Replace the selection with exactly this one post (plain click, space, arrow
// navigation, focusing a single similar post).
export function selectOnly(id: number): void {
  committed.value = new Set([id])
}

// Replace the selection with exactly this set of ids (Ctrl+A, select-all,
// undo/redo highlight).
export function selectAll(ids: Iterable<number | undefined>): void {
  committed.value = new Set(ids)
}

// Add one post to the committed selection, keeping the rest (shift/ctrl
// context-menu).
export function addToSelection(id: number): void {
  if (committed.value.has(id)) {
    return
  }
  committed.value = new Set(committed.value).add(id)
}

// Toggle one post in the committed selection (ctrl click, ctrl+space).
export function toggle(id: number): void {
  const next = new Set(committed.value)
  if (next.has(id)) {
    next.delete(id)
  }
  else {
    next.add(id)
  }
  committed.value = next
}

// Clear the whole selection (empty-area click, Escape, after delete).
export function clear(): void {
  committed.value = new Set()
}

// Plain pointer-up on an already-selected item collapses the selection to just
// that item — unless the item was picked up by an in-flight gesture (a drag
// just finished on it), in which case leave the multi-selection intact.
export function collapseSelectionTo(id: number): void {
  if (!committed.value.has(id)) {
    return
  }
  if (selecting.value.has(id)) {
    return
  }
  committed.value = new Set([id])
}

// ---------------------------------------------------------------------------
// Write API — in-flight gesture (drag-box + shift/ctrl click)
// ---------------------------------------------------------------------------

interface SelectModifiers {
  shift: boolean
  ctrl: boolean
}

// Feed the current gesture the ids it is hovering. The modifiers decide how the
// hit set folds into the transient layers, matching the three drag-box modes:
//  - shift: additive — union the hits into `selecting` (never shrinks).
//  - ctrl:  toggle vs committed — already-committed hits go to `unselected`,
//           the rest to `selecting`.
//  - plain: replace `selecting` with the current hits (shrinks as you drag out).
export function updatePendingSelection(ids: Iterable<number | undefined>, { shift, ctrl }: SelectModifiers): void {
  const current = new Set(ids)
  if (shift) {
    selecting.value = new Set([...selecting.value, ...current])
  }
  else if (ctrl) {
    const nextSelecting = new Set(selecting.value)
    const nextUnselected = new Set(unselected.value)
    for (const id of current) {
      if (committed.value.has(id)) {
        nextUnselected.add(id)
      }
      else {
        nextSelecting.add(id)
      }
    }
    selecting.value = nextSelecting
    unselected.value = nextUnselected
  }
  else {
    selecting.value = current
  }
}

// Shift-click on a single item: toggle it within the transient layer. Not yet
// committed or being added → stage it in `selecting`; otherwise stage it for
// removal in `unselected`. Committed on the next `commitPendingSelection`.
export function togglePendingAt(id: number): void {
  if (!selecting.value.has(id) && !committed.value.has(id)) {
    selecting.value = new Set(selecting.value).add(id)
  }
  else {
    unselected.value = new Set(unselected.value).add(id)
  }
}

// Gesture end: fold the transient layers into the committed selection and reset
// them. committed := (committed ∪ selecting) ∖ unselected.
export function commitPendingSelection(): void {
  committed.value = new Set(
    [...committed.value, ...selecting.value].filter(id => !unselected.value.has(id)),
  )
  selecting.value = new Set()
  unselected.value = new Set()
}
