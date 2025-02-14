import { type MaybeComputedElementRef, tryOnMounted, unrefElement, useEventListener, useMediaQuery, useResizeObserver } from '@vueuse/core'
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
  const el = computed(() => unrefElement(target))
  const update = () => {
    if (el.value) {
      clientHeight.value = el.value.clientHeight
    }
  }

  update()
  tryOnMounted(update)
  useEventListener('resize', update, { passive: true })
  useResizeObserver(() => el.value, update)

  if (listenOrientation) {
    const matches = useMediaQuery('(orientation: portrait)')
    watch(matches, () => update())
  }

  return clientHeight
}

export function useClientWidth(target: MaybeComputedElementRef, options: {
  initialWidth?: number
  initialHeight?: number
  listenOrientation?: boolean
} = {}) {
  const {
    initialHeight = Number.POSITIVE_INFINITY,
    listenOrientation = true,
  } = options

  const clientWidth = ref(initialHeight)
  const el = computed(() => unrefElement(target))
  const update = () => {
    if (el.value) {
      clientWidth.value = el.value.clientWidth
    }
  }

  update()
  tryOnMounted(update)
  useEventListener('resize', update, { passive: true })
  useResizeObserver(() => el.value, update)

  if (listenOrientation) {
    const matches = useMediaQuery('(orientation: portrait)')
    watch(matches, () => update())
  }

  return clientWidth
}
