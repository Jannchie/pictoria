import type { MaybeComputedElementRef } from '@vueuse/core'
import type { MaybeRefOrGetter } from 'vue'
import type { PostImageRef } from '@/utils'
import { useDevicePixelRatio, useElementSize, useIntersectionObserver } from '@vueuse/core'
import { computed, onScopeDispose, ref, toValue, watch } from 'vue'
import { getPostImageURL, getPostThumbnailURL } from '@/utils'

/** Thumbnail width cap — must match `create_thumbnail`'s `max_width` in server/src/utils.py. */
export const THUMBNAIL_WIDTH = 400

// Formats every browser renders. GIF is left out on purpose: the original is
// animated, and a grid of animations running is not what a sharper tile means.
const HI_RES_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'bmp'])

// A tile has to stay on screen this long before its original is requested, so
// a fast scroll does not fire (and then abort) a request per tile it flies past.
const DWELL_MS = 150

export interface HiResPost extends PostImageRef {
  width?: number | null
}

/** Whether a tile `tileWidth` CSS px wide needs more pixels than the thumbnail has. */
export function needsHiRes(post: HiResPost, tileWidth: number, pixelRatio: number) {
  return HI_RES_EXTENSIONS.has(post.extension.toLowerCase())
    && (post.width ?? 0) > THUMBNAIL_WIDTH
    && tileWidth * pixelRatio > THUMBNAIL_WIDTH
}

/**
 * The `src` for a gallery tile: the thumbnail, swapped for the original only
 * while the tile is in the viewport *and* drawn wider (in device pixels) than
 * the thumbnail. The original is fetched and decoded off-DOM first, so the swap
 * never flashes; leaving the viewport drops back to the thumbnail (the original
 * stays in the HTTP cache — image responses are `immutable`).
 */
export function useViewportHiRes(target: MaybeComputedElementRef, post: MaybeRefOrGetter<HiResPost>) {
  const { width } = useElementSize(target)
  const { pixelRatio } = useDevicePixelRatio()
  const visible = ref(false)
  useIntersectionObserver(target, ([entry]) => {
    visible.value = entry?.isIntersecting ?? false
  })

  const thumbnailURL = computed(() => getPostThumbnailURL(toValue(post)))
  const wantedURL = computed(() => {
    const p = toValue(post)
    return visible.value && needsHiRes(p, width.value, pixelRatio.value) ? getPostImageURL(p) : undefined
  })
  const hiResURL = ref<string>()

  let timer: ReturnType<typeof setTimeout> | undefined
  let loader: HTMLImageElement | undefined
  function cancel() {
    clearTimeout(timer)
    timer = undefined
    if (loader) {
      // Clearing src aborts the in-flight request.
      loader.src = ''
      loader = undefined
    }
  }

  watch(wantedURL, (url) => {
    cancel()
    if (!url) {
      hiResURL.value = undefined
      return
    }
    if (hiResURL.value === url) {
      return
    }
    timer = setTimeout(() => {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      loader = img
      img.decode().then(() => {
        if (loader === img) {
          loader = undefined
          hiResURL.value = url
        }
      }, () => {
        // Undecodable or aborted: the thumbnail stays.
      })
    }, DWELL_MS)
  }, { immediate: true })
  onScopeDispose(cancel)

  const src = computed(() => hiResURL.value ?? thumbnailURL.value)
  return { src }
}
