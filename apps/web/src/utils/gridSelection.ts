// Pure, Vue-free selection maths for the gallery grid's keyboard model.
//
// The grid keeps three things apart (Finder / Figma / React Aria style):
// - the *cursor*  — the item keyboard focus is on (drawn as a focus ring);
// - the *anchor*  — where a Shift range starts;
// - the *selection* — the set batch actions act on.
// A range is always taken in list order (the order posts arrive in, which is
// also the reading order of the masonry), never by screen geometry.

/** Ids from `a` to `b` inclusive, in list order. Empty if either id is missing. */
export function rangeBetween(order: readonly number[], a: number, b: number): number[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i === -1 || j === -1) {
    return []
  }
  return i <= j ? order.slice(i, j + 1) : order.slice(j, i + 1)
}

/**
 * Shift-extension of a selection (React Aria's `extendSelection`): drop the
 * range the previous extension added (`anchor..previousEnd`), then add the new
 * one (`anchor..to`). Items selected outside that range (Ctrl/Space toggles)
 * survive, and moving back towards the anchor shrinks the range.
 */
export function extendRange<T extends number | undefined>(
  selected: Iterable<T>,
  order: readonly number[],
  anchor: number,
  previousEnd: number,
  to: number,
): Set<T | number> {
  const out = new Set<T | number>(selected)
  for (const id of rangeBetween(order, anchor, previousEnd)) {
    out.delete(id)
  }
  for (const id of rangeBetween(order, anchor, to)) {
    out.add(id)
  }
  return out
}

/**
 * Where the cursor goes after `removed` disappear from `order`: the cursor
 * itself if it survives, else the first surviving item after it, else the
 * last surviving item before it. With no cursor (or a cursor that is not in
 * the list) the first removed item's position stands in for it. `null` when
 * nothing survives.
 */
export function nextCursorAfterRemoval(
  order: readonly number[],
  removed: Iterable<number>,
  cursor: number | null,
): number | null {
  const gone = new Set(removed)
  if (cursor !== null && order.includes(cursor) && !gone.has(cursor)) {
    return cursor
  }
  let pivot = cursor === null ? -1 : order.indexOf(cursor)
  if (pivot === -1) {
    pivot = order.findIndex(id => gone.has(id))
  }
  if (pivot === -1) {
    return order.find(id => !gone.has(id)) ?? null
  }
  for (let i = pivot + 1; i < order.length; i++) {
    if (!gone.has(order[i])) {
      return order[i]
    }
  }
  for (let i = pivot - 1; i >= 0; i--) {
    if (!gone.has(order[i])) {
      return order[i]
    }
  }
  return null
}
