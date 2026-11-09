import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useImageLoadPhase } from '@/composables/useImageLoadPhase'

function setup() {
  const source = ref(1)
  const scope = effectScope()
  const phase = scope.run(() => useImageLoadPhase(source))!
  return { source, phase }
}

describe('useimageloadphase', () => {
  it('a failed load is its own state, not a load that never finished', () => {
    const { phase } = setup()
    expect(phase.phase.value).toBe('loading')
    phase.onError()
    expect(phase.phase.value).toBe('failed')
    expect(phase.loaded.value).toBe(false)
  })

  it('retry goes back to loading under a new attempt (a fresh <img> key)', () => {
    const { phase } = setup()
    phase.onError()
    phase.retry()
    expect(phase.phase.value).toBe('loading')
    expect(phase.attempt.value).toBe(1)
    phase.onLoad()
    expect(phase.loaded.value).toBe(true)
  })

  it('a new source starts over, attempts included', async () => {
    const { source, phase } = setup()
    phase.onError()
    phase.retry()
    phase.onLoad()
    source.value = 2
    await nextTick()
    expect(phase.phase.value).toBe('loading')
    expect(phase.attempt.value).toBe(0)
  })

  it('settlefrom reads a cached element, telling broken from decoded', () => {
    const { phase } = setup()
    phase.settleFrom({ complete: false, naturalWidth: 0 } as HTMLImageElement)
    expect(phase.phase.value).toBe('loading')
    phase.settleFrom({ complete: true, naturalWidth: 0 } as HTMLImageElement)
    expect(phase.phase.value).toBe('failed')
    phase.settleFrom({ complete: true, naturalWidth: 640 } as HTMLImageElement)
    expect(phase.phase.value).toBe('loaded')
  })
})
