import type { MaybeComputedElementRef } from '@vueuse/core'
import { tryOnMounted, unrefElement, useEventListener, useMediaQuery, useResizeObserver } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

export function useClientHeight(target: MaybeComputedElementRef, options: {
  initialHeight?: number
  listenOrientation?: boolean
} = {}) {
  const {
    initialHeight = Number.POSITIVE_INFINITY,
    listenOrientation = true,
  } = options

  const clientHeight = ref(initialHeight)
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
