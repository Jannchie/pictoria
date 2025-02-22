import { shallowRef, watch } from 'vue'

export interface UseElementOffsetOptions {
  /**
   * Reset values to 0 on component unmounted
   *
   * @default true
   */
  reset?: boolean

  /**
   * Listen to window resize event
   *
   * @default true
   */
  windowResize?: boolean
  /**
   * Listen to window scroll event
   *
   * @default true
   */
  windowScroll?: boolean

  /**
   * Immediately call update on component mounted
   *
   * @default true
   */
  immediate?: boolean

  /**
   * Timing to recalculate the bounding box
   *
   * Setting to `next-frame` can be useful when using this together with something like {@link useBreakpoints}
   * and therefore the layout (which influences the bounding box of the observed element) is not updated on the current tick.
   *
   * @default 'sync'
   */
  updateTiming?: 'sync' | 'next-frame'
}

/**
 * Reactive offset of an HTML element.
 *
 * @param target
 */
export function useElementOffset(
  target: MaybeRef<HTMLElement | null | undefined>,
  options: UseElementOffsetOptions = {},
) {
  const {
    reset = true,
    windowResize = true,
    windowScroll = true,
    immediate = true,
    updateTiming = 'sync',
  } = options

  const offsetLeft = shallowRef(0)
  const offsetTop = shallowRef(0)

  function recalculate() {
    const el = unrefElement(target)

    if (!el) {
      if (reset) {
        offsetLeft.value = 0
        offsetTop.value = 0
      }
      return
    }
    offsetLeft.value = el.offsetLeft
    offsetTop.value = el.offsetTop
  }

  function update() {
    if (updateTiming === 'sync') {
      recalculate()
    }
    else if (updateTiming === 'next-frame') {
      requestAnimationFrame(() => recalculate())
    }
  }

  useResizeObserver(target, update)
  watch(() => unrefElement(target), ele => !ele && update())
  // trigger by css or style
  useMutationObserver(target, update, {
    attributeFilter: ['style', 'class'],
  })

  if (windowScroll) {
    useEventListener('scroll', update, { capture: true, passive: true })
  }
  if (windowResize) {
    useEventListener('resize', update, { passive: true })
  }

  tryOnMounted(() => {
    if (immediate) {
      update()
    }
  })

  return {
    offsetLeft,
    offsetTop,
    update,
  }
}

export type UseElementBoundingReturn = ReturnType<typeof useElementOffset>
