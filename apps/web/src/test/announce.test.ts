// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { announce } from '@/shared/announce'

const region = (p: 'polite' | 'assertive') => document.querySelector<HTMLElement>(`[data-announcer="${p}"]`)

afterEach(() => {
  vi.useRealTimers()
})

describe('announce', () => {
  it('creates persistent, layer-safe live regions lazily', () => {
    vi.useFakeTimers()
    expect(region('polite')).toBeNull()
    announce('hello')
    announce('boom', 'assertive')
    const polite = region('polite')!
    const assertive = region('assertive')!
    expect(polite.getAttribute('role')).toBe('status')
    expect(polite.getAttribute('aria-live')).toBe('polite')
    expect(polite.getAttribute('aria-atomic')).toBe('true')
    expect(polite.dataset.layerKeepActive).toBe('')
    expect(assertive.getAttribute('role')).toBe('alert')
    expect(assertive.getAttribute('aria-live')).toBe('assertive')
    vi.advanceTimersByTime(50)
    expect(polite.textContent).toBe('hello')
    expect(assertive.textContent).toBe('boom')
  })

  it('clears first so identical text is re-announced, last message wins', () => {
    vi.useFakeTimers()
    announce('same')
    vi.advanceTimersByTime(50)
    const polite = region('polite')!
    announce('same')
    expect(polite.textContent).toBe('')
    vi.advanceTimersByTime(50)
    expect(polite.textContent).toBe('same')
    announce('first')
    announce('second')
    vi.advanceTimersByTime(50)
    expect(polite.textContent).toBe('second')
    expect(document.querySelectorAll('[data-announcer="polite"]')).toHaveLength(1)
  })

  it('recreates the region if something removed it', () => {
    vi.useFakeTimers()
    announce('x')
    region('polite')!.remove()
    announce('y')
    vi.advanceTimersByTime(50)
    expect(region('polite')!.textContent).toBe('y')
  })
})
