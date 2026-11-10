// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { router } from '@/router'
import { isGalleryRoute } from '@/shared/galleryView'

// `meta.gallery` used to be declared next to `meta.view` on every gallery
// route; it is derived now, so the two can't disagree.
describe('isgalleryroute', () => {
  it('is true exactly on the waterfall routes', () => {
    const gallery = router.getRoutes().filter(isGalleryRoute).map(r => r.path).sort()
    expect(gallery).toEqual(['/', '/all', '/dir/:folder*', '/random', '/recently', '/unrated-artists'])
  })

  it('resolves concrete urls', () => {
    expect(isGalleryRoute(router.resolve('/dir/a/b'))).toBe(true)
    expect(isGalleryRoute(router.resolve('/post/1'))).toBe(false)
    expect(isGalleryRoute(router.resolve('/annotate'))).toBe(false)
  })
})
