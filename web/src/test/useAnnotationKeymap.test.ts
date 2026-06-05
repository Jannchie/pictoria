import { describe, expect, it } from 'vitest'
import { activeKeys, KEY_ROWS, keyToChoice } from '@/composables/useAnnotationKeymap'

const DIMS = ['color', 'finish', 'composition']

describe('keyToChoice', () => {
  it('maps row keys to (dimension, value) within scale', () => {
    expect(keyToChoice('1', DIMS, 2)).toEqual({ dimension: 'color', value: 1 })
    expect(keyToChoice('2', DIMS, 2)).toEqual({ dimension: 'color', value: 2 })
    expect(keyToChoice('q', DIMS, 2)).toEqual({ dimension: 'finish', value: 1 })
    expect(keyToChoice('a', DIMS, 3)).toEqual({ dimension: 'composition', value: 1 })
    expect(keyToChoice('d', DIMS, 3)).toEqual({ dimension: 'composition', value: 3 })
  })

  it('rejects keys beyond scale', () => {
    expect(keyToChoice('3', DIMS, 2)).toBeNull() // scale=2 时第三档不存在
    expect(keyToChoice('5', DIMS, 3)).toBeNull()
  })

  it('rejects keys for rows beyond dimension count', () => {
    expect(keyToChoice('a', ['color'], 2)).toBeNull()
  })

  it('supports 5-scale single-dimension (legacy overall)', () => {
    expect(keyToChoice('5', ['overall'], 5)).toEqual({ dimension: 'overall', value: 5 })
  })

  it('exposes key rows for UI hints', () => {
    expect(KEY_ROWS[0][0]).toBe('1')
    expect(KEY_ROWS[1][0]).toBe('q')
  })
})

describe('activeKeys', () => {
  it('returns the listened keys for dimensions x scale', () => {
    expect(activeKeys(DIMS, 2)).toEqual(['1', '2', 'q', 'w', 'a', 's'])
    expect(activeKeys(['overall'], 5)).toEqual(['1', '2', '3', '4', '5'])
  })
})
