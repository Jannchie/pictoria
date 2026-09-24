/**
 * DOM focus helpers shared by the focus trap, roving focus and layers.
 *
 * "Tabbable" here means: reachable with Tab, i.e. focusable, `tabIndex >= 0`,
 * not disabled, not inside `[inert]`, and rendered (has client rects and is
 * not `visibility: hidden`). Order follows the browser: positive tabindex
 * ascending first, then tabindex 0 in document order. Of a native radio
 * group only the checked radio (or the first one when none is checked) is
 * tabbable, matching how browsers tab into radio groups.
 */

const CANDIDATE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable]:not([contenteditable=false])',
  '[tabindex]',
].join(',')

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true
}

function isHiddenInput(el: HTMLElement): boolean {
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden'
}

/** Rendered and not `visibility: hidden` / `display: none` (incl. ancestors). */
export function isVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) {
    return false
  }
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility
  return check ? check.call(el, { visibilityProperty: true }) : true
}

/**
 * Effective tab index. A contenteditable host without an explicit tabindex
 * is tabbable (0) even where the DOM reports -1 (older engines, happy-dom).
 */
function tabOrder(el: HTMLElement): number {
  if (!el.hasAttribute('tabindex') && el.isContentEditable) {
    return 0
  }
  return el.tabIndex
}

/** Whether `el` could receive focus from Tab right now. */
export function isTabbable(el: HTMLElement): boolean {
  return tabOrder(el) >= 0
    && !isDisabled(el)
    && !isHiddenInput(el)
    && !el.closest('[inert]')
    && isVisible(el)
}

/** Keep only one radio per native group: the checked one, else the first. */
function collapseRadioGroups(els: HTMLElement[]): HTMLElement[] {
  const byGroup = new Map<string, HTMLInputElement[]>()
  for (const el of els) {
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const key = `${el.form?.id ?? ''}\u0000${el.name}`
      const group = byGroup.get(key) ?? []
      group.push(el)
      byGroup.set(key, group)
    }
  }
  if (byGroup.size === 0) {
    return els
  }
  const keep = new Set<HTMLElement>()
  for (const group of byGroup.values()) {
    keep.add(group.find(r => r.checked) ?? group[0])
  }
  return els.filter(el => !(el instanceof HTMLInputElement && el.type === 'radio' && el.name) || keep.has(el))
}

/** Tabbable descendants of `container` in Tab order (the container itself is excluded). */
export function getFocusable(container: HTMLElement | null | undefined): HTMLElement[] {
  if (!container) {
    return []
  }
  const candidates = [...container.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)]
    .filter(isTabbable)
  const positive = candidates
    .filter(el => tabOrder(el) > 0)
    .sort((a, b) => tabOrder(a) - tabOrder(b)) // Array#sort is stable → DOM order within a tabindex
  const zero = candidates.filter(el => tabOrder(el) === 0)
  return collapseRadioGroups([...positive, ...zero])
}

/**
 * Focuses `el`. Returns whether focus actually landed there (it won't for an
 * inert / hidden / non-focusable element).
 */
export function focusElement(el: HTMLElement | null | undefined, options: { preventScroll?: boolean } = {}): boolean {
  if (!el) {
    return false
  }
  el.focus({ preventScroll: options.preventScroll })
  return el.ownerDocument.activeElement === el
}

/** Focuses the first tabbable element inside `container`. Returns whether it did. */
export function focusFirst(container: HTMLElement | null | undefined, options: { preventScroll?: boolean } = {}): boolean {
  const [first] = getFocusable(container)
  return focusElement(first, options)
}
