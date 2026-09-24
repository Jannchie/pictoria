// @vitest-environment happy-dom
import type { UseRovingFocusOptions } from '@/composables/useRovingFocus'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { stepIndex, useRovingFocus } from '@/composables/useRovingFocus'

function byId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!
}

function none() {
  return false
}

describe('stepindex', () => {
  it('moves, wraps and clamps', () => {
    expect(stepIndex(0, 1, 3, none, true)).toBe(1)
    expect(stepIndex(2, 1, 3, none, true)).toBe(0)
    expect(stepIndex(2, 1, 3, none, false)).toBe(2)
    expect(stepIndex(0, -1, 3, none, true)).toBe(2)
    expect(stepIndex(-1, 1, 3, none, true)).toBe(0)
    expect(stepIndex(3, -1, 3, none, true)).toBe(2)
  })

  it('skips blocked items and stays when all are blocked', () => {
    expect(stepIndex(0, 1, 4, i => i === 1, true)).toBe(2)
    expect(stepIndex(0, 1, 3, () => true, true)).toBe(0)
    expect(stepIndex(1, 1, 3, i => i === 2, false)).toBe(1)
  })

  it('returns -1 for an empty list', () => {
    expect(stepIndex(0, 1, 0, () => false, true)).toBe(-1)
  })
})

let scope: ReturnType<typeof effectScope> | undefined
afterEach(() => {
  scope?.stop()
  scope = undefined
})

async function setup(html: string, options: Partial<UseRovingFocusOptions> = {}) {
  document.body.innerHTML = `<button id="before">b</button><div id="c">${html}</div>`
  const container = byId('c')
  scope = effectScope()
  const api = scope.run(() => useRovingFocus({ container: () => container, ...options }))!
  await nextTick()
  const items = [...container.querySelectorAll<HTMLElement>('[data-roving-item]')]
  const press = (key: string, init: KeyboardEventInit = {}) => {
    const target = (document.activeElement ?? container) as HTMLElement
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(e)
    return e
  }
  return { api, container, items, press }
}

const tabindexes = (items: HTMLElement[]) => items.map(el => el.getAttribute('tabindex'))
const LIST = ['Alpha', 'Beta', 'Gamma', 'Delta'].map(t => `<div data-roving-item>${t}</div>`).join('')

describe('userovingfocus', () => {
  it('makes exactly one item tabbable, preferring the checked one', async () => {
    const { items, api } = await setup(`
      <div data-roving-item role="radio" aria-checked="false">a</div>
      <div data-roving-item role="radio" aria-checked="true">b</div>
      <div data-roving-item role="radio" aria-checked="false">c</div>`)
    expect(tabindexes(items)).toEqual(['-1', '0', '-1'])
    expect(api.activeIndex.value).toBe(1)
  })

  it('moves with arrows per orientation, wraps, home/end', async () => {
    const onMove = vi.fn()
    const { items, press, api } = await setup(LIST, { onMove })
    items[0].focus()
    press('ArrowDown')
    expect(document.activeElement).toBe(items[1])
    expect(tabindexes(items)).toEqual(['-1', '0', '-1', '-1'])
    expect(onMove).toHaveBeenLastCalledWith(items[1], 1)
    press('ArrowRight') // vertical: ignored
    expect(document.activeElement).toBe(items[1])
    press('End')
    expect(document.activeElement).toBe(items[3])
    press('ArrowDown')
    expect(document.activeElement).toBe(items[0])
    press('ArrowUp')
    expect(document.activeElement).toBe(items[3])
    press('Home')
    expect(api.activeIndex.value).toBe(0)
  })

  it('does not loop when loop=false and ignores modified keys', async () => {
    const { items, press } = await setup(LIST, { loop: false })
    items[3].focus()
    press('ArrowDown')
    expect(document.activeElement).toBe(items[3])
    const e = press('ArrowUp', { ctrlKey: true })
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(items[3])
  })

  it('mirrors horizontal arrows under rtl', async () => {
    const { items, press, container } = await setup(LIST, { orientation: 'horizontal' })
    items[1].focus()
    press('ArrowRight')
    expect(document.activeElement).toBe(items[2])
    container.style.direction = 'rtl'
    press('ArrowRight')
    expect(document.activeElement).toBe(items[1])
    press('ArrowDown') // horizontal: ignored
    expect(document.activeElement).toBe(items[1])
  })

  it('skips disabled items unless skipdisabled=false', async () => {
    const html = '<div data-roving-item>a</div><div data-roving-item aria-disabled="true">b</div><button data-roving-item disabled>c</button><div data-roving-item>d</div>'
    const first = await setup(html)
    first.items[0].focus()
    first.press('ArrowDown')
    expect(document.activeElement).toBe(first.items[3])
    scope!.stop()

    const second = await setup(html, { skipDisabled: false })
    second.items[0].focus()
    second.press('ArrowDown')
    expect(document.activeElement).toBe(second.items[1])
  })

  it('pages by pagesize, clamped', async () => {
    const html = Array.from({ length: 25 }, (_, i) => `<div data-roving-item>${i}</div>`).join('')
    const { items, press } = await setup(html)
    items[0].focus()
    press('PageDown')
    expect(document.activeElement).toBe(items[10])
    press('PageDown')
    press('PageDown')
    expect(document.activeElement).toBe(items[24])
    press('PageUp')
    expect(document.activeElement).toBe(items[14])
  })

  it('supports typeahead against text or data-typeahead', async () => {
    const { items, press } = await setup(`${LIST}<div data-roving-item data-typeahead="Zeta">?</div>`, { typeahead: true })
    items[0].focus()
    press('g')
    expect(document.activeElement).toBe(items[2])
    press('z')
    expect(document.activeElement).toBe(items[2]) // 'gz' matches nothing
  })

  it('does not steal keys from a text field inside an item', async () => {
    const { items, press } = await setup('<div data-roving-item><input id="i"></div><div data-roving-item>b</div>')
    const input = byId('i')
    input.focus()
    const e = press('ArrowDown')
    expect(e.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(items.length).toBe(2)
  })

  it('follows focus from clicks and re-syncs on dom changes', async () => {
    const { items, container } = await setup(LIST)
    items[2].focus()
    expect(tabindexes(items)).toEqual(['-1', '-1', '0', '-1'])
    items[2].remove()
    await Promise.resolve()
    await Promise.resolve()
    const now = [...container.querySelectorAll<HTMLElement>('[data-roving-item]')]
    expect(now.filter(el => el.getAttribute('tabindex') === '0')).toHaveLength(1)
    const added = document.createElement('div')
    added.dataset.rovingItem = ''
    container.append(added)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(added.getAttribute('tabindex')).toBe('-1')
  })

  it('exposes focusitem / focusfirst / focuslast', async () => {
    const { items, api } = await setup(LIST)
    api.focusLast()
    expect(document.activeElement).toBe(items[3])
    api.focusFirst()
    expect(document.activeElement).toBe(items[0])
    api.focusItem(99)
    expect(document.activeElement).toBe(items[3])
  })
})
