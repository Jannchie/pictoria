import type { MaybeRefOrGetter, Ref } from 'vue'
import { onBeforeUnmount, onMounted, toValue, watchEffect } from 'vue'
import { isSplitterKey, splitterKeyAction } from '@/utils/paneSplitter'

/** One collapsible side pane of the Splitpanes layout. */
export interface SidePaneSpec {
  /** The pane element's id (the splitter's aria-controls). */
  id: string
  /** Which side of the centre pane it sits on. */
  side: 'left' | 'right'
  /** Current size in percent; written on keyboard resize. */
  size: Ref<number>
  /** Lower bound in percent (may be reactive, e.g. a pixel floor converted to %). */
  min: MaybeRefOrGetter<number>
  max: number
  /** Accessible name of the splitter (i18n, read reactively). */
  label: () => string
  /** Enter on the splitter: hide the pane. */
  collapse: () => void
}

/**
 * Makes splitpanes' splitters keyboard-operable WAI-ARIA window splitters.
 *
 * Splitpanes (≥4) builds the `.splitpanes__splitter` divs imperatively and
 * rebuilds them whenever a pane is added/removed, so the enhancement is done on
 * the DOM: a MutationObserver re-applies role=separator / tabindex /
 * aria-value* / aria-controls / aria-label, and a keydown listener runs the
 * pure key model from `utils/paneSplitter`. Pass `:keyboard-step="0"` to
 * <Splitpanes> so its own (5 %-step, no Home/End) handler stays off.
 *
 * A splitter belongs to the side pane it touches: the one before it for a
 * left pane, the one after it for a right pane.
 */
export function usePaneSplitters(root: MaybeRefOrGetter<HTMLElement | null | undefined>, panes: SidePaneSpec[]) {
  const bound = new WeakSet<HTMLElement>()

  function specOf(splitter: HTMLElement): SidePaneSpec | undefined {
    const prev = splitter.previousElementSibling
    const next = splitter.nextElementSibling
    return panes.find(p => (p.side === 'left' ? prev?.id === p.id : next?.id === p.id))
  }

  function onKeydown(e: KeyboardEvent) {
    const splitter = e.currentTarget as HTMLElement
    const spec = specOf(splitter)
    if (!spec || e.isComposing) {
      return
    }
    const action = splitterKeyAction(e, { value: spec.size.value, min: toValue(spec.min), max: spec.max }, spec.side === 'left' ? 'ArrowRight' : 'ArrowLeft')
    if (!action) {
      if (isSplitterKey(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
      }
      return
    }
    e.preventDefault()
    if (action.type === 'resize') {
      spec.size.value = action.value
    }
    else {
      spec.collapse()
    }
  }

  function enhance() {
    const el = toValue(root)
    if (!el) {
      return
    }
    for (const splitter of el.querySelectorAll<HTMLElement>(':scope > .splitpanes__splitter')) {
      const spec = specOf(splitter)
      if (!spec) {
        continue
      }
      splitter.setAttribute('role', 'separator')
      splitter.setAttribute('tabindex', '0')
      splitter.setAttribute('aria-orientation', 'vertical')
      splitter.setAttribute('aria-controls', spec.id)
      splitter.setAttribute('aria-label', spec.label())
      splitter.setAttribute('aria-valuemin', String(toValue(spec.min)))
      splitter.setAttribute('aria-valuemax', String(spec.max))
      splitter.setAttribute('aria-valuenow', String(Math.round(spec.size.value)))
      if (!bound.has(splitter)) {
        bound.add(splitter)
        splitter.addEventListener('keydown', onKeydown)
      }
    }
  }

  let observer: MutationObserver | undefined
  onMounted(() => {
    const el = toValue(root)
    if (el && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(enhance)
      observer.observe(el, { childList: true })
    }
    enhance()
  })
  onBeforeUnmount(() => observer?.disconnect())

  // Sizes and labels are reactive: re-stamp aria-valuenow / aria-label.
  watchEffect(() => {
    for (const p of panes) {
      void p.size.value
      void toValue(p.min)
      p.label()
    }
    enhance()
  }, { flush: 'post' })
}
