import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetToasts, dismissToast, pauseToasts, pushToast, resumeToasts, toasts } from '@/shared/toast'

describe('toast queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    _resetToasts()
  })
  afterEach(() => {
    _resetToasts()
    vi.useRealTimers()
  })

  it('gives every toast a distinct, stable id', () => {
    const a = pushToast({ type: 'info', message: 'a' })
    const b = pushToast({ type: 'info', message: 'a' })
    expect(a.id).not.toBe(b.id)
    expect(toasts.value.map(t => t.id)).toEqual([a.id, b.id])
  })

  it('auto-dismisses after its duration', () => {
    pushToast({ type: 'info', message: 'a', duration: 1000 })
    vi.advanceTimersByTime(999)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0)
  })

  it('keeps toasts without a duration', () => {
    pushToast({ type: 'info', message: 'a' })
    vi.advanceTimersByTime(60_000)
    expect(toasts.value).toHaveLength(1)
  })

  it('dismisses by id or by toast, and only that one', () => {
    const a = pushToast({ type: 'info', message: 'a', duration: 1000 })
    const b = pushToast({ type: 'info', message: 'b' })
    const c = pushToast({ type: 'info', message: 'c' })
    dismissToast(a.id)
    dismissToast(toasts.value.find(t => t.id === c.id)!)
    expect(toasts.value.map(t => t.id)).toEqual([b.id])
    // a's timer was cleared: firing it later must not remove b.
    vi.advanceTimersByTime(5000)
    expect(toasts.value.map(t => t.id)).toEqual([b.id])
  })

  it('pauses countdowns and resumes with the remaining time', () => {
    pushToast({ type: 'info', message: 'a', duration: 1000 })
    vi.advanceTimersByTime(600)
    pauseToasts()
    vi.advanceTimersByTime(10_000)
    expect(toasts.value).toHaveLength(1)
    resumeToasts()
    vi.advanceTimersByTime(399)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0)
  })

  it('holds toasts pushed while paused until resumed', () => {
    pauseToasts()
    pushToast({ type: 'error', message: 'a', duration: 500 })
    vi.advanceTimersByTime(5000)
    expect(toasts.value).toHaveLength(1)
    resumeToasts()
    vi.advanceTimersByTime(500)
    expect(toasts.value).toHaveLength(0)
  })

  it('treats repeated pause / resume as idempotent', () => {
    pushToast({ type: 'info', message: 'a', duration: 1000 })
    vi.advanceTimersByTime(400)
    pauseToasts()
    vi.advanceTimersByTime(300)
    pauseToasts()
    resumeToasts()
    resumeToasts()
    vi.advanceTimersByTime(599)
    expect(toasts.value).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(toasts.value).toHaveLength(0)
  })
})
