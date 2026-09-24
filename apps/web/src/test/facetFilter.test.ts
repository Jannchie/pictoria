import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateOptionOnKey, facetOptionLabel, facetTriggerLabel, formatPct, initialOptionIndex } from '@/composables/useFacetFilter'
import { i18n, localeSetting } from '@/locale'

type KeyInit = Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>>

function keyEvent(init: KeyInit): KeyboardEvent {
  const e = {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    ...init,
    preventDefault: vi.fn(() => {
      e.defaultPrevented = true
    }),
  }
  return e as unknown as KeyboardEvent
}

const t = (key: string, named: Record<string, unknown>, plural: number) => i18n.global.t(key, named, plural)

describe('activateoptiononkey', () => {
  it('toggles on space and enter and consumes the key', () => {
    for (const key of [' ', 'Enter']) {
      const activate = vi.fn()
      const e = keyEvent({ key })
      expect(activateOptionOnKey(e, activate)).toBe(true)
      expect(activate).toHaveBeenCalledOnce()
      expect(e.preventDefault).toHaveBeenCalled()
    }
  })

  it('consumes but does not re-toggle on auto-repeat', () => {
    const activate = vi.fn()
    const e = keyEvent({ key: ' ', repeat: true })
    expect(activateOptionOnKey(e, activate)).toBe(true)
    expect(activate).not.toHaveBeenCalled()
  })

  it('ignores other keys, modifier chords, ime and handled events', () => {
    const activate = vi.fn()
    for (const init of [
      { key: 'ArrowDown' },
      { key: 'a' },
      { key: 'Enter', ctrlKey: true },
      { key: ' ', metaKey: true },
      { key: 'Enter', altKey: true },
      { key: 'Enter', isComposing: true },
      { key: 'Enter', defaultPrevented: true },
    ]) {
      const e = keyEvent(init)
      expect(activateOptionOnKey(e, activate)).toBe(false)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(activate).not.toHaveBeenCalled()
  })
})

describe('initialoptionindex', () => {
  it('picks the first selected option in display order', () => {
    expect(initialOptionIndex([1, 2, 3, 4, 0], v => v === 3 || v === 0)).toBe(2)
  })
  it('falls back to the first option', () => {
    expect(initialOptionIndex(['a', 'b'], () => false)).toBe(0)
    expect(initialOptionIndex([], () => true)).toBe(0)
  })
})

describe('facet labels', () => {
  beforeEach(() => {
    localeSetting.value = 'en'
  })

  it('puts the count in the option name, pluralised and localised', () => {
    expect(facetOptionLabel(t, 'Safe', 1234)).toBe('Safe, 1,234 posts')
    expect(facetOptionLabel(t, 'Safe', 1)).toBe('Safe, 1 post')
    expect(facetOptionLabel(t, 'Safe', 0)).toBe('Safe, 0 posts')
  })

  it('omits the count while counts are unknown', () => {
    expect(facetOptionLabel(t, 'Safe', undefined)).toBe('Safe')
  })

  it('names the facet in the trigger only when something is selected', () => {
    expect(facetTriggerLabel(t, 'Rating', [])).toBe('Rating')
    expect(facetTriggerLabel(t, 'Rating', ['Safe', 'Sensitive'])).toBe('Rating: Safe, Sensitive')
  })
})

describe('formatpct', () => {
  it('formats one decimal and guards a zero total', () => {
    expect(formatPct(1, 4)).toBe('25.0')
    expect(formatPct(3, 0)).toBe('0.0')
  })
})
