// @vitest-environment happy-dom
import type { EffectScope } from 'vue'
import type { ThumbTiming } from '@/composables/useThumbPile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useThumbPile } from '@/composables/useThumbPile'

// Fixed timing: enter after 100ms, leave after 100ms, 200ms fade.
const TIMING: ThumbTiming = { enterDelay: 100, leaveDelay: 100, duration: 200 }
const REMOVE_AT = TIMING.leaveDelay + TIMING.duration + 40

interface Post { id: number }

let scope: EffectScope
const source = ref<Post[]>([])

function setup() {
  scope = effectScope()
  return scope.run(() => useThumbPile(source, () => TIMING))!
}

async function select(...ids: number[]) {
  source.value = ids.map(id => ({ id }))
  await nextTick()
}

// One rAF is a ~16ms timer under fake timers.
function advance(ms: number) {
  vi.advanceTimersByTime(ms)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  source.value = []
})

afterEach(() => {
  scope.stop()
  vi.useRealTimers()
})

describe('usethumbpile', () => {
  it('enters, then shows a selected thumb', async () => {
    const pile = setup()
    await select(1)
    expect(pile.value).toMatchObject([{ id: 1, phase: 'entering', opacity: 0 }])
    advance(TIMING.enterDelay + 20)
    expect(pile.value).toMatchObject([{ id: 1, phase: 'shown', opacity: 1 }])
  })

  it('fades out and removes a deselected thumb', async () => {
    const pile = setup()
    await select(1)
    advance(200)
    await select()
    expect(pile.value[0]).toMatchObject({ phase: 'leaving', opacity: 1 })
    advance(TIMING.leaveDelay + 20)
    expect(pile.value[0]).toMatchObject({ phase: 'leaving', opacity: 0 })
    advance(REMOVE_AT)
    expect(pile.value).toEqual([])
  })

  it('deselect then quick reselect keeps the thumb (no stale fade-out / removal)', async () => {
    const pile = setup()
    await select(1)
    advance(200)
    await select()
    advance(10) // before the fade-out starts
    await select(1)
    expect(pile.value[0]).toMatchObject({ phase: 'shown', opacity: 1 })
    advance(REMOVE_AT * 2)
    expect(pile.value).toMatchObject([{ id: 1, phase: 'shown', opacity: 1 }])
  })

  it('reselect after the fade-out started fades it back in and keeps it', async () => {
    const pile = setup()
    await select(1)
    advance(200)
    await select()
    advance(TIMING.leaveDelay + 20) // faded to 0, removal still pending
    expect(pile.value[0]!.opacity).toBe(0)
    await select(1)
    expect(pile.value[0]!.phase).toBe('entering')
    advance(REMOVE_AT * 2)
    expect(pile.value).toMatchObject([{ id: 1, phase: 'shown', opacity: 1 }])
  })

  it('deselect while fading in never shows the thumb and removes it', async () => {
    const pile = setup()
    await select(1)
    advance(10) // still entering, opacity 0
    await select()
    expect(pile.value[0]!.phase).toBe('leaving')
    advance(TIMING.enterDelay + 50)
    expect(pile.value[0]?.opacity ?? 0).toBe(0)
    advance(REMOVE_AT)
    expect(pile.value).toEqual([])
  })

  it('stopping the scope cancels pending work', async () => {
    const pile = setup()
    await select(1)
    scope.stop()
    advance(1000)
    expect(pile.value).toMatchObject([{ id: 1, phase: 'entering', opacity: 0 }])
  })
})
