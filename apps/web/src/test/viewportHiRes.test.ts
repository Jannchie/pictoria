import { describe, expect, it } from 'vitest'
import { needsHiRes, THUMBNAIL_WIDTH } from '@/composables/useViewportHiRes'

const post = (extension: string, width: number | null) => ({ filePath: 'a', fileName: 'b', extension, width })

describe('needshires', () => {
  it('wants the original once the tile outgrows the thumbnail in device pixels', () => {
    expect(needsHiRes(post('png', 4000), 520, 1)).toBe(true)
    expect(needsHiRes(post('png', 4000), 300, 2)).toBe(true)
    expect(needsHiRes(post('png', 4000), 300, 1)).toBe(false)
    expect(needsHiRes(post('png', 4000), THUMBNAIL_WIDTH, 1)).toBe(false)
  })

  it('keeps the thumbnail when it already is the original', () => {
    expect(needsHiRes(post('jpg', THUMBNAIL_WIDTH), 800, 2)).toBe(false)
    expect(needsHiRes(post('jpg', null), 800, 2)).toBe(false)
  })

  it('skips formats a tile should not swap to', () => {
    expect(needsHiRes(post('gif', 4000), 800, 2)).toBe(false)
    expect(needsHiRes(post('tiff', 4000), 800, 2)).toBe(false)
    expect(needsHiRes(post('JPG', 4000), 800, 2)).toBe(true)
  })
})
