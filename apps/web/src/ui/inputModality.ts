/**
 * Last input modality — "was the most recent interaction a key press or a
 * pointer?" plus the last pointer position.
 *
 * Floating layers use it to decide where to appear: a window opened from a
 * hotkey anchors to the focused element (`document.activeElement`), one
 * opened from a click anchors to the cursor. Module-level on purpose — there
 * is one keyboard and one pointer per page.
 *
 * Listeners are passive, capture-phase and installed lazily on first use, so
 * importing this in node (tests) does nothing.
 */

let installed = false
let keyboard = false
const pointer = { x: 0, y: 0 }

function onKeydown(): void {
  keyboard = true
}

function onPointer(e: PointerEvent): void {
  pointer.x = e.clientX
  pointer.y = e.clientY
  if (e.type === 'pointerdown') {
    keyboard = false
  }
}

/** Starts tracking (idempotent). Call from a component's setup. */
export function trackInputModality(): void {
  if (installed || typeof document === 'undefined') {
    return
  }
  installed = true
  const opts = { capture: true, passive: true }
  document.addEventListener('keydown', onKeydown, opts)
  document.addEventListener('pointerdown', onPointer, opts)
  document.addEventListener('pointermove', onPointer, opts)
}

/** True when the last interaction was a key press (not a pointer press). */
export function lastInputWasKeyboard(): boolean {
  return keyboard
}

/** The last known pointer position (client coordinates). */
export function lastPointerPosition(): { x: number, y: number } {
  return { x: pointer.x, y: pointer.y }
}
