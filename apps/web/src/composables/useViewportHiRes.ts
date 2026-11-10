import type { MaybeComputedElementRef } from '@vueuse/core'
import type { InjectionKey, MaybeRefOrGetter, Ref } from 'vue'
import type { PostImageRef } from '@/utils'
import { unrefElement, useDevicePixelRatio } from '@vueuse/core'
import { computed, inject, onScopeDispose, provide, ref, toValue, watch } from 'vue'
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
 * What every tile of one grid shares. A grid used to cost three observers per
 * tile (a ResizeObserver for its width, a DPR media query, an
 * IntersectionObserver) — hundreds of each on a full screen, all reporting the
 * same column width and the same DPR. The grid owner now provides them once.
 */
interface GalleryTilesContext {
  /** CSS width of one tile (every column of a waterfall is the same width). */
  tileWidth: Readonly<Ref<number>>
  pixelRatio: Readonly<Ref<number>>
  /** Report `el`'s viewport visibility through one shared IntersectionObserver; returns the unobserve. */
  observe: (el: Element, onChange: (visible: boolean) => void) => () => void
}

const galleryTilesKey: InjectionKey<GalleryTilesContext> = Symbol('galleryTiles')

/**
 * Provide the shared tile context for a grid's `PostItem`s. Call it in the
 * component that owns the Waterfall.
 *
 * The IntersectionObserver stays (shared) even though vue-wf only mounts tiles
 * near the viewport: "near" includes the `rangeExpand` margin, and a tile in
 * that margin should get its thumbnail early but not its original.
 */
export function provideGalleryTiles(tileWidth: MaybeRefOrGetter<number>): void {
  const { pixelRatio } = useDevicePixelRatio()
  const listeners = new Map<Element, (visible: boolean) => void>()
  let io: IntersectionObserver | undefined
  function observer() {
    if (!io && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          listeners.get(entry.target)?.(entry.isIntersecting)
        }
      })
    }
    return io
  }
  const context: GalleryTilesContext = {
    tileWidth: computed(() => toValue(tileWidth)),
    pixelRatio,
    observe(el, onChange) {
      listeners.set(el, onChange)
      observer()?.observe(el)
      return () => {
        listeners.delete(el)
        io?.unobserve(el)
      }
    },
  }
  provide(galleryTilesKey, context)
  onScopeDispose(() => {
    io?.disconnect()
    io = undefined
    listeners.clear()
  })
}

/**
 * The `src` for a gallery tile: the thumbnail, swapped for the original only
 * while the tile is in the viewport *and* drawn wider (in device pixels) than
 * the thumbnail. The original is fetched and decoded off-DOM first, so the swap
 * never flashes; leaving the viewport drops back to the thumbnail (the original
 * stays in the HTTP cache — image responses are `immutable`).
 *
 * Width, DPR and visibility come from the grid's [[provideGalleryTiles]]; a
 * tile outside such a grid just shows its thumbnail.
 */
export function useViewportHiRes(target: MaybeComputedElementRef, post: MaybeRefOrGetter<HiResPost>) {
  const tiles = inject(galleryTilesKey, null)
  const visible = ref(false)
  if (tiles) {
    watch(() => unrefElement(target), (el, _, onCleanup) => {
      visible.value = false
      if (el) {
        onCleanup(tiles.observe(el, (v) => {
          visible.value = v
        }))
      }
    }, { immediate: true })
  }

  const thumbnailURL = computed(() => getPostThumbnailURL(toValue(post)))
  const wantedURL = computed(() => {
    const p = toValue(post)
    return tiles && visible.value && needsHiRes(p, tiles.tileWidth.value, tiles.pixelRatio.value) ? getPostImageURL(p) : undefined
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
