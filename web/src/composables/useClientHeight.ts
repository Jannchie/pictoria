import type { MaybeComputedElementRef } from '@vueuse/core'
import { tryOnMounted, unrefElement, useEventListener, useMediaQuery, useResizeObserver } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

export function useClientHeight(target: MaybeComputedElementRef, options: {
  initialWidth?: number
  initialHeight?: number
  listenOrientation?: boolean
} = {}) {
  const {
    initialWidth = Number.POSITIVE_INFINITY,
    listenOrientation = true,
  } = options

  const clientHeight = ref(initialWidth)
  const element = computed(() => unrefElement(target))
  const update = () => {
    if (element.value) {
      clientHeight.value = element.value.clientHeight
    }
  }

  update()
  tryOnMounted(update)
  useEventListener('resize', update, { passive: true })
  useResizeObserver(() => element.value, update)

  if (listenOrientation) {
    const matches = useMediaQuery('(orientation: portrait)')
    watch(matches, () => update())
  }

  return clientHeight
}
