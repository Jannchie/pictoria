import type { ComputedRef, MaybeRefOrGetter, Ref } from 'vue'
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue'

/**
 * Dismissable layer stack — the one owner of Escape and outside-click for
 * every floating layer (dialog, overlay, popover, menu, float window).
 *
 * Why a stack: before it, each layer bound its own window Escape listener and
 * every other window listener (grid clear-selection, router.back, the detail
 * overlay) fired on the same key. Now:
 *
 * - **Escape**: ONE `document` keydown listener in the capture phase. While
 *   any layer is open it calls the *top* layer's `onEscape` and swallows the
 *   event (`preventDefault` + `stopImmediatePropagation` + `stopPropagation`),
 *   so no window / element Escape handler below ever sees it — including
 *   `@keydown.esc` handlers on elements inside the layer. A layer without
 *   `onEscape` still swallows Escape (something is open).
 *   Escape hatch: an event whose target is inside an element marked
 *   `data-layer-escape-passthrough` is left alone entirely (for a widget
 *   inside a layer that must handle Escape itself, e.g. clearing an input).
 * - **Outside pointerdown**: ONE `document` pointerdown capture listener.
 *   Only the top layer is checked; if the target is outside its `el()` and
 *   every `inside()` element, `onPointerDownOutside` runs. It never stops
 *   propagation — the click still reaches whatever was clicked.
 * - **Inert**: while a layer with `inertOthers` (default: `modal`) is open,
 *   every `document.body` child that contains neither that layer's `el()` nor
 *   the `el()` of any layer above it gets `inert`, except elements marked
 *   `data-layer-keep-active` (live regions, toast container). Only `inert`
 *   attributes this module added are removed again.
 *   Inerting is skipped when the modal's `el()` lives inside `#app` (not
 *   teleported): `#app` would be the kept body child, so only unrelated
 *   teleported siblings (toasts, other popups) would go inert — worse than
 *   nothing. Layers that want inert must `<Teleport to="body">`.
 *
 * Node-safe: document listeners are installed lazily on the first push.
 */

export interface LayerOptions {
  /** The layer's root (content) element. Read lazily — may be null before mount. */
  el: () => HTMLElement | null | undefined
  /** Dialog-like. Drives {@link hasModalLayer} (→ `isAnyDialogOpen`) and inert. */
  modal?: boolean
  /** Escape while this layer is on top. Omit → Escape is still swallowed, but nothing happens. */
  onEscape?: (e: KeyboardEvent) => void
  /** pointerdown outside `el()` and `inside()` while this layer is on top. */
  onPointerDownOutside?: (e: PointerEvent) => void
  /**
   * Extra elements that count as "inside" for outside-click — typically the
   * trigger button, so clicking it toggles instead of close-then-reopen.
   */
  inside?: () => (HTMLElement | null | undefined)[]
  /** Inert everything outside this layer while open. Default = `modal`. */
  inertOthers?: boolean
}

export interface Layer extends LayerOptions {
  readonly id: number
}

export interface LayerHandle {
  readonly id: number
  /** Pops this layer (idempotent). Safe to call even if it isn't on top. */
  remove: () => void
  /** Whether this layer is currently the top of the stack. */
  isTop: () => boolean
  /** Re-evaluate inert (e.g. once `el()` exists after a late mount). */
  refresh: () => void
}

/** Replaced (never mutated) on every change so computeds track it. */
const stack = shallowRef<readonly Layer[]>([])
let nextId = 1
let listenersInstalled = false

/** Number of open layers. */
export const layerCount: Readonly<Ref<number>> = computed(() => stack.value.length)
/** True while any `modal: true` layer is open. */
export const hasModalLayer: ComputedRef<boolean> = computed(() => stack.value.some(l => l.modal))

/** The top-most layer, or undefined when the stack is empty. */
export function topLayer(): Layer | undefined {
  return stack.value.at(-1)
}

/** Whether layer `id` is the top of the stack. Reactive when read in a computed. */
export function isTopLayer(id: number): boolean {
  return stack.value.at(-1)?.id === id
}

/** Pushes a layer onto the stack. Prefer {@link useLayer} inside components. */
export function pushLayer(options: LayerOptions): LayerHandle {
  installListeners()
  const layer: Layer = { ...options, id: nextId++ }
  stack.value = [...stack.value, layer]
  scheduleInertUpdate()
  return {
    id: layer.id,
    remove: () => removeLayer(layer.id),
    isTop: () => isTopLayer(layer.id),
    refresh: scheduleInertUpdate,
  }
}

function removeLayer(id: number): void {
  if (!stack.value.some(l => l.id === id)) {
    return
  }
  stack.value = stack.value.filter(l => l.id !== id)
  updateInert()
}

/**
 * Registers a layer while `active` is true (pushed after the DOM update, so
 * `el()` already resolves) and removes it when `active` turns false or the
 * owning scope is disposed.
 *
 * @example
 * const panel = useTemplateRef('panel')
 * const { isTop } = useLayer(open, { el: () => panel.value, onEscape: () => { open.value = false }, onPointerDownOutside: () => { open.value = false }, inside: () => [trigger.value] })
 */
export function useLayer(active: MaybeRefOrGetter<boolean>, options: LayerOptions): { isTop: ComputedRef<boolean> } {
  const id = ref<number | null>(null)
  let handle: LayerHandle | null = null
  const stop = () => {
    handle?.remove()
    handle = null
    id.value = null
  }
  watch(() => toValue(active), (on) => {
    if (on && !handle) {
      handle = pushLayer(options)
      id.value = handle.id
    }
    else if (!on) {
      stop()
    }
  }, { immediate: true, flush: 'post' })
  if (getCurrentScope()) {
    onScopeDispose(stop)
  }
  return { isTop: computed(() => id.value != null && isTopLayer(id.value)) }
}

// ---------------------------------------------------------------------------
// Document listeners
// ---------------------------------------------------------------------------

function installListeners(): void {
  if (listenersInstalled || typeof document === 'undefined') {
    return
  }
  listenersInstalled = true
  document.addEventListener('keydown', onKeydown, true)
  document.addEventListener('pointerdown', onPointerDown, true)
}

function targetElement(e: Event): Element | null {
  const t = (e.composedPath?.()[0] ?? e.target) as Node | null
  if (!t) {
    return null
  }
  return t.nodeType === 1 ? t as Element : t.parentElement
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) {
    return
  }
  const top = topLayer()
  if (!top) {
    return
  }
  if (targetElement(e)?.closest('[data-layer-escape-passthrough]')) {
    return
  }
  e.preventDefault()
  e.stopImmediatePropagation()
  e.stopPropagation()
  top.onEscape?.(e)
}

function onPointerDown(e: PointerEvent): void {
  const top = topLayer()
  if (!top?.onPointerDownOutside) {
    return
  }
  const target = targetElement(e)
  if (!target || !target.isConnected) {
    return
  }
  const insideEls = [top.el(), ...(top.inside?.() ?? [])]
  if (insideEls.some(el => el?.contains(target))) {
    return
  }
  top.onPointerDownOutside(e)
}

// ---------------------------------------------------------------------------
// Inert
// ---------------------------------------------------------------------------

/** Body children this module set `inert` on (and therefore may un-set). */
const inertedByUs = new Set<Element>()
let inertScheduled = false

/** Updates now, and once more after the next frame in case `el()` mounts late. */
function scheduleInertUpdate(): void {
  updateInert()
  if (inertScheduled || typeof requestAnimationFrame === 'undefined') {
    return
  }
  inertScheduled = true
  requestAnimationFrame(() => {
    inertScheduled = false
    updateInert()
  })
}

/** The set of body children that should be inert right now (empty = none). */
function computeInertTargets(): Set<Element> {
  const result = new Set<Element>()
  if (typeof document === 'undefined' || !document.body) {
    return result
  }
  const layers = stack.value
  let modalIndex = -1
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].inertOthers ?? layers[i].modal) {
      modalIndex = i
      break
    }
  }
  if (modalIndex === -1) {
    return result
  }
  const modalEl = layers[modalIndex].el()
  // Not mounted yet → can't tell what to keep; not teleported → see header.
  if (!modalEl || document.querySelector('#app')?.contains(modalEl)) {
    return result
  }
  const keep = layers.slice(modalIndex).map(l => l.el()).filter((el): el is HTMLElement => !!el)
  for (const child of document.body.children) {
    if ((child as HTMLElement).dataset?.layerKeepActive !== undefined) {
      continue
    }
    if (keep.some(el => child.contains(el))) {
      continue
    }
    result.add(child)
  }
  return result
}

function updateInert(): void {
  const targets = computeInertTargets()
  for (const el of inertedByUs) {
    if (!targets.has(el)) {
      el.removeAttribute('inert')
      inertedByUs.delete(el)
    }
  }
  for (const el of targets) {
    // Leave elements someone else made inert alone — we'd wrongly clear them later.
    if (!inertedByUs.has(el) && !el.hasAttribute('inert')) {
      el.setAttribute('inert', '')
      inertedByUs.add(el)
    }
  }
}
