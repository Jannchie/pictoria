// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { preferredSizesFromResize, resolveCollapsed } from '@/shared/paneLayout'

describe('resolvecollapsed', () => {
  it('a wide window shows exactly the persisted preference', () => {
    expect(resolveCollapsed(false, false, null)).toBe(false)
    expect(resolveCollapsed(true, false, null)).toBe(true)
  })

  it('a narrow window collapses the pane without touching the preference', () => {
    expect(resolveCollapsed(false, true, null)).toBe(true)
  })

  it('a toggle made while auto-collapsed wins until the threshold is crossed', () => {
    expect(resolveCollapsed(false, true, false)).toBe(false)
    expect(resolveCollapsed(true, true, false)).toBe(false)
    expect(resolveCollapsed(false, true, true)).toBe(true)
  })
})

describe('preferredsizesfromresize', () => {
  const layout = { left: true, right: true }
  const panes = [{ size: 30 }, { size: 40 }, { size: 30 }]

  it('ignores the re-layout splitpanes emits when a pane is added / removed (auto-collapse and back)', () => {
    expect(preferredSizesFromResize({ panes }, layout)).toEqual({})
    expect(preferredSizesFromResize({}, layout)).toEqual({})
  })

  it('stores a user drag, skipping collapsed panes', () => {
    const event = new Event('mouseup')
    expect(preferredSizesFromResize({ event, panes }, layout)).toEqual({ left: 30, right: 30 })
    expect(preferredSizesFromResize({ event, panes: [{ size: 80 }, { size: 20 }] }, { left: false, right: true })).toEqual({ right: 20 })
  })
})
