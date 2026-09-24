/**
 * Pure helpers shared by the overlay primitives (PPopover, PTooltip, PMenu,
 * PFloatWindow). DOM-free so they are unit-tested in node.
 */

export interface Point { x: number, y: number }
export interface Size { width: number, height: number }
export interface RectLike { x: number, y: number, width: number, height: number }

/**
 * Keeps a box of `size` whose top-left corner is `pos` inside a viewport,
 * `margin` px from every edge. When the box is bigger than the viewport the
 * top-left edge wins (the start of the content stays reachable).
 */
export function clampToViewport(pos: Point, size: Size, viewport: Size, margin = 0): Point {
  const clamp = (v: number, len: number, total: number) => {
    const max = total - len - margin
    return Math.max(margin, Math.min(v, max))
  }
  return {
    x: clamp(pos.x, size.width, viewport.width),
    y: clamp(pos.y, size.height, viewport.height),
  }
}

/**
 * Intersects `rect` with the viewport. Used to anchor a menu to a focused
 * element that is larger than (or partly scrolled out of) the viewport, so
 * flip / shift work against the part the user can actually see. A rect
 * fully outside collapses to a zero-size rect on the nearest edge.
 */
export function clipRectToViewport(rect: RectLike, viewport: Size): RectLike {
  const left = Math.min(Math.max(rect.x, 0), viewport.width)
  const top = Math.min(Math.max(rect.y, 0), viewport.height)
  const right = Math.max(Math.min(rect.x + rect.width, viewport.width), left)
  const bottom = Math.max(Math.min(rect.y + rect.height, viewport.height), top)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * Whether a `contextmenu` event came from the keyboard (Shift+F10 / the
 * ContextMenu key) rather than a right click. Browsers report keyboard
 * context menus at (0, 0) or near the focused element; the reliable signal
 * is that the last interaction was a key press.
 */
export function isKeyboardContextMenu(e: { clientX: number, clientY: number }, lastWasKeyboard: boolean): boolean {
  return lastWasKeyboard || (e.clientX === 0 && e.clientY === 0)
}

export interface MenuItemLike {
  role?: 'label' | 'divider' | 'item'
  title?: string
}

export type MenuSection<T>
  = | { kind: 'divider', key: number }
  | { kind: 'group', key: number, label: { title: string, index: number } | null, items: { item: T, index: number }[] }

/**
 * Splits a flat menu description into sections for ARIA: each `label` row
 * opens a `role=group` (labelled by that row) holding the following items up
 * to the next divider or label; items before any label form an unlabelled
 * run (rendered without a group). `index` is the position in `data`.
 * Empty unlabelled runs are dropped; a label with no items still renders.
 */
export function groupMenuItems<T extends MenuItemLike>(data: readonly T[]): MenuSection<T>[] {
  const sections: MenuSection<T>[] = []
  let current: Extract<MenuSection<T>, { kind: 'group' }> | null = null
  const flush = () => {
    if (current && (current.label || current.items.length > 0)) {
      sections.push(current)
    }
    current = null
  }
  for (const [index, item] of data.entries()) {
    if (item.role === 'divider') {
      flush()
      sections.push({ kind: 'divider', key: index })
    }
    else if (item.role === 'label') {
      flush()
      current = { kind: 'group', key: index, label: { title: item.title ?? '', index }, items: [] }
    }
    else {
      current ??= { kind: 'group', key: index, label: null, items: [] }
      current.items.push({ item, index })
    }
  }
  flush()
  return sections
}

/**
 * The element that follows `anchor` in `order` (a Tab-order list), skipping
 * elements for which `skip` is true. Returns null when `anchor` is not in the
 * list or nothing follows it. Used by PPopover to continue the natural Tab
 * order from its trigger when Tab leaves the (teleported) content.
 */
export function nextInOrder<T>(order: readonly T[], anchor: T, skip: (el: T) => boolean = () => false): T | null {
  const start = order.indexOf(anchor)
  if (start === -1) {
    return null
  }
  for (let i = start + 1; i < order.length; i++) {
    if (!skip(order[i])) {
      return order[i]
    }
  }
  return null
}
