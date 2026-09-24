import type { MaybeRefOrGetter } from 'vue'
import { useEventListener } from '@vueuse/core'
import { getCurrentScope, onScopeDispose, toValue, watch } from 'vue'
import { focusElement, getFocusable } from '@/utils/focus'

/**
 * Focus management for layers.
 *
 * - {@link useFocusReturn}: remember what had focus when a layer opened and
 *   give it back when it closes. Non-modal popovers / menus use this alone.
 * - {@link useFocusTrap}: focus return + initial focus + Tab / Shift+Tab
 *   cycling inside the container. Modal dialogs use this.
 *
 * Focus-return rule: on close, focus goes back to the remembered element if
 * it is still connected, else to the `returnFocus()` fallback — UNLESS focus
 * has already moved somewhere intentional outside the layer (activeElement is
 * neither `<body>` nor inside the container), e.g. the user clicked another
 * input to dismiss a popover. Stealing focus back from there would be wrong.
 * The return runs in a microtask, so a layer that is closing in the same tick
 * has already dropped its `inert` on the rest of the page by then.
 */

type ElementGetter = () => HTMLElement | null | undefined

export interface FocusReturnOptions {
  /**
   * The layer's element. Needed to tell "focus is still inside the closing
   * layer" (→ return it) from "focus moved elsewhere" (→ leave it). Without
   * it, only a `<body>` activeElement triggers the return.
   */
  container?: MaybeRefOrGetter<HTMLElement | null | undefined>
  /** `false` disables the return; a function supplies a fallback target. Default `true`. */
  returnFocus?: boolean | ElementGetter
}

function activeElementOf(doc: Document): HTMLElement | null {
  return doc.activeElement as HTMLElement | null
}

/**
 * Remembers `document.activeElement` whenever `active` turns true and
 * returns focus there when it turns false (or the scope is disposed while
 * active). See the module comment for the exact rule.
 *
 * @example
 * useFocusReturn(open, { container: () => panel.value })
 */
export function useFocusReturn(active: MaybeRefOrGetter<boolean>, options: FocusReturnOptions = {}): void {
  if (typeof document === 'undefined') {
    return
  }
  let previous: HTMLElement | null = null
  // The container as it was while open — the ref is usually null by the time we close.
  let lastContainer: HTMLElement | null = null
  let isOpen = false

  const open = () => {
    isOpen = true
    previous = activeElementOf(document)
  }
  const close = () => {
    if (!isOpen) {
      return
    }
    isOpen = false
    const container = toValue(options.container) ?? lastContainer
    const remembered = previous
    previous = null
    lastContainer = null
    if (options.returnFocus === false) {
      return
    }
    queueMicrotask(() => {
      const current = activeElementOf(document)
      const movedAway = current != null
        && current !== document.body
        && !(container?.contains(current))
      if (movedAway) {
        return
      }
      if (remembered && remembered !== document.body && remembered.isConnected
        && focusElement(remembered, { preventScroll: true })) {
        return
      }
      if (typeof options.returnFocus === 'function') {
        focusElement(options.returnFocus(), { preventScroll: true })
      }
    })
  }

  watch(() => toValue(options.container), (el) => {
    if (el) {
      lastContainer = el
    }
  }, { immediate: true, flush: 'sync' })
  // `sync`: capture activeElement *before* the layer mounts and moves focus.
  watch(() => toValue(active), (on) => {
    if (on) {
      open()
    }
    else {
      close()
    }
  }, { immediate: true, flush: 'sync' })
  if (getCurrentScope()) {
    onScopeDispose(close)
  }
}

export interface FocusTrapOptions {
  /**
   * Where focus goes on activation:
   * - function → that element (falls through to the default chain if it returns nothing),
   * - `'first'` / omitted → `[data-autofocus]` → first tabbable → the container,
   * - `'container'` → the container itself (gets `tabindex=-1` if it has none),
   * - `false` → don't move focus.
   * If focus is already inside the container on activation, it is left there.
   */
  initialFocus?: ElementGetter | 'first' | 'container' | false
  /** As in {@link FocusReturnOptions.returnFocus}. Default `true`. */
  returnFocus?: boolean | ElementGetter
  /** Cycle Tab / Shift+Tab inside the container. Default `true`. */
  trapTab?: boolean
}

function focusContainer(container: HTMLElement): void {
  if (!container.hasAttribute('tabindex')) {
    container.setAttribute('tabindex', '-1')
  }
  focusElement(container)
}

function moveInitialFocus(container: HTMLElement, initialFocus: FocusTrapOptions['initialFocus']): void {
  if (initialFocus === false) {
    return
  }
  const active = activeElementOf(container.ownerDocument)
  if (active && container.contains(active)) {
    return
  }
  if (initialFocus === 'container') {
    focusContainer(container)
    return
  }
  if (typeof initialFocus === 'function' && focusElement(initialFocus())) {
    return
  }
  const auto = container.querySelector<HTMLElement>('[data-autofocus]')
  if (focusElement(auto)) {
    return
  }
  const [first] = getFocusable(container)
  if (focusElement(first)) {
    return
  }
  focusContainer(container)
}

/**
 * While `active` (and the container is mounted): moves focus into the
 * container, keeps Tab / Shift+Tab cycling inside it, and on deactivation
 * returns focus per {@link useFocusReturn}. Pair with a modal layer
 * (`useLayer(open, { modal: true, … })`) so the page behind is inert and
 * mouse focus can't escape either.
 *
 * @example
 * const panel = useTemplateRef<HTMLElement>('panel')
 * useFocusTrap(panel, open, { initialFocus: () => confirmButton.value })
 */
export function useFocusTrap(
  container: MaybeRefOrGetter<HTMLElement | null | undefined>,
  active: MaybeRefOrGetter<boolean>,
  options: FocusTrapOptions = {},
): void {
  if (typeof document === 'undefined') {
    return
  }
  useFocusReturn(active, { container, returnFocus: options.returnFocus ?? true })

  // Initial focus once both the flag is on and the element exists (post-flush
  // so v-if content is in the DOM).
  let focusedFor: HTMLElement | null = null
  watch(
    () => [toValue(active), toValue(container)] as const,
    ([on, el]) => {
      if (!on || !el) {
        focusedFor = null
        return
      }
      if (focusedFor !== el) {
        focusedFor = el
        moveInitialFocus(el, options.initialFocus)
      }
    },
    { immediate: true, flush: 'post' },
  )

  if (options.trapTab === false) {
    return
  }
  useEventListener(() => toValue(container), 'keydown', (e: KeyboardEvent) => {
    const el = toValue(container)
    if (!el || !toValue(active) || e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) {
      return
    }
    const items = getFocusable(el)
    const current = activeElementOf(el.ownerDocument)
    if (items.length === 0) {
      e.preventDefault()
      focusContainer(el)
      return
    }
    const index = current ? items.indexOf(current) : -1
    let target: HTMLElement | undefined
    if (index === -1) {
      // Focus sits on a non-tabbable element inside (e.g. tabindex=-1): if a
      // tabbable exists in the Tab direction the browser reaches it on its
      // own; otherwise wrap around.
      if (current && current !== el && el.contains(current)) {
        const ahead = e.shiftKey
          ? items.findLast(i => current.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING)
          : items.find(i => current.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING)
        if (ahead) {
          return
        }
      }
      target = e.shiftKey ? items.at(-1) : items[0]
    }
    else if (e.shiftKey && index === 0) {
      target = items.at(-1)
    }
    else if (!e.shiftKey && index === items.length - 1) {
      target = items[0]
    }
    else {
      return
    }
    e.preventDefault()
    focusElement(target)
  })
}
