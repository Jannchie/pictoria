import type { WatchSource } from 'vue'
import { computed, ref, watch } from 'vue'

/**
 * Where one <img> is in its load.
 *
 * A bare `loaded` flag cannot tell "still loading" from "will never load": a
 * failed request (file gone from disk, API restarting) left it `false` for good,
 * and an image kept at opacity 0 until load reads as loading forever. `failed`
 * is its own state so the caller can say so and offer `retry`.
 */
export type ImageLoadPhase = 'loading' | 'loaded' | 'failed'

/**
 * Load phase for an image whose source follows `source` (a post id, say):
 * every change of it starts over at `loading`.
 *
 * `attempt` goes into the <img>'s `:key` alongside the source, so `retry`
 * remounts the element and the browser requests the image again.
 */
export function useImageLoadPhase(source: WatchSource<unknown>) {
  const phase = ref<ImageLoadPhase>('loading')
  const attempt = ref(0)

  watch(source, () => {
    phase.value = 'loading'
    attempt.value = 0
  })

  return {
    phase,
    attempt,
    loaded: computed(() => phase.value === 'loaded'),
    onLoad: () => {
      phase.value = 'loaded'
    },
    onError: () => {
      phase.value = 'failed'
    },
    retry: () => {
      phase.value = 'loading'
      attempt.value += 1
    },
    /**
     * For an element that may have settled before its listeners were attached
     * (served from cache). `complete` is true for a broken image too — it just
     * decodes to zero pixels.
     */
    settleFrom: (img: HTMLImageElement | null | undefined) => {
      if (img?.complete) {
        phase.value = img.naturalWidth > 0 ? 'loaded' : 'failed'
      }
    },
  }
}
