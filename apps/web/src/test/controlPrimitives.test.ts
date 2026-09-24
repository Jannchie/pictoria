// @vitest-environment happy-dom
import type { Component } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { i18n } from '@/locale'
import PButton from '@/ui/PButton.vue'
import PCheckbox from '@/ui/PCheckbox.vue'
import PListItem from '@/ui/PListItem.vue'
import PRating from '@/ui/PRating.vue'
import PSlider from '@/ui/PSlider.vue'

const cleanups: (() => void)[] = []

function mount(render: () => ReturnType<typeof h>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render })
  app.use(i18n)
  app.component('PCheckbox', PCheckbox as Component)
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return host
}

function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(e)
  return e
}

function stars(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLElement>('[role=radio]')]
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c()
  }
})

describe('pbutton', () => {
  it('keeps a loading button focusable and swallows its clicks', async () => {
    const onClick = vi.fn()
    const loading = ref(false)
    const host = mount(() => h(PButton, { loading: loading.value, onClick }, () => 'Go'))
    const btn = host.querySelector('button')!
    btn.focus()
    loading.value = true
    await nextTick()
    expect(btn.disabled).toBe(false)
    expect(btn.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(btn)
    btn.click()
    expect(onClick).not.toHaveBeenCalled()
    loading.value = false
    await nextTick()
    btn.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('maps pressed to aria-pressed only when given', () => {
    const host = mount(() => h('div', [h(PButton, { pressed: true }), h(PButton)]))
    const [a, b] = host.querySelectorAll('button')
    expect(a.getAttribute('aria-pressed')).toBe('true')
    expect(b.hasAttribute('aria-pressed')).toBe(false)
  })
})

describe('pcheckbox', () => {
  it('reflects indeterminate on the native input', async () => {
    const host = mount(() => h(PCheckbox, { indeterminate: true, modelValue: false }))
    await nextTick()
    expect(host.querySelector('input')!.indeterminate).toBe(true)
  })

  it('presentational boxes leave the tab order', () => {
    const host = mount(() => h(PCheckbox, { presentational: true }))
    expect(host.querySelector('input')!.tabIndex).toBe(-1)
    expect(host.querySelector('label')!.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('plistitem', () => {
  it('is a focusable row with a role, and enter / space click it once', () => {
    const onClick = vi.fn()
    const onActivate = vi.fn()
    const host = mount(() => h(PListItem, { title: 'A', role: 'menuitem', onClick, onActivate }))
    const row = host.querySelector<HTMLElement>('[role=menuitem]')!
    expect(row.getAttribute('tabindex')).toBe('0')
    expect(key(row, 'Enter').defaultPrevented).toBe(true)
    key(row, ' ')
    key(row, 'Enter', { repeat: true })
    key(row, 'Enter', { isComposing: true })
    expect(onClick).toHaveBeenCalledTimes(2)
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('leaves tabindex to a roving parent and exposes aria-checked for checkbox rows', () => {
    const host = mount(() => h(PListItem, { title: 'A', role: 'menuitemcheckbox', type: 'checkbox', active: true, focusable: false }))
    const row = host.querySelector<HTMLElement>('[role=menuitemcheckbox]')!
    expect(row.hasAttribute('tabindex')).toBe(false)
    expect(row.getAttribute('aria-checked')).toBe('true')
    // The inner visual checkbox must not be a second Tab stop.
    expect(host.querySelector('input')!.tabIndex).toBe(-1)
  })

  it('renders a plain div without role as before', () => {
    const host = mount(() => h(PListItem, { title: 'A' }))
    const row = host.firstElementChild as HTMLElement
    expect(row.tagName).toBe('DIV')
    expect(row.hasAttribute('tabindex')).toBe(false)
    expect(row.hasAttribute('role')).toBe(false)
  })
})

describe('prating', () => {
  it('selects on click, and clicking the selected star clears it when unselectable', async () => {
    const value = ref(0)
    const onSelect = vi.fn()
    const host = mount(() => h(PRating, {
      'modelValue': value.value,
      'onUpdate:modelValue': (v: number) => {
        value.value = v
      },
      onSelect,
      'unselectable': true,
    }))
    stars(host)[2].click()
    await nextTick()
    expect(value.value).toBe(3)
    stars(host)[2].click()
    await nextTick()
    expect(value.value).toBe(0)
    expect(onSelect.mock.calls).toEqual([[3], [0]])
  })

  it('space / enter select without toggling off; delete clears when unselectable', async () => {
    const value = ref(2)
    const onSelect = vi.fn()
    const host = mount(() => h(PRating, {
      'modelValue': value.value,
      'onUpdate:modelValue': (v: number) => {
        value.value = v
      },
      onSelect,
      'unselectable': true,
    }))
    key(stars(host)[1], ' ')
    await nextTick()
    expect(value.value).toBe(2)
    expect(onSelect).not.toHaveBeenCalled()
    key(stars(host)[3], 'Enter')
    await nextTick()
    expect(value.value).toBe(4)
    expect(key(stars(host)[3], 'Delete').defaultPrevented).toBe(true)
    await nextTick()
    expect(value.value).toBe(0)
  })

  it('arrows check the next star; readonly only moves focus; disabled leaves the tab order', async () => {
    const value = ref(1)
    const readonly = ref(false)
    const disabled = ref(false)
    const host = mount(() => h(PRating, {
      'modelValue': value.value,
      'onUpdate:modelValue': (v: number) => {
        value.value = v
      },
      'readonly': readonly.value,
      'disabled': disabled.value,
    }))
    key(stars(host)[0], 'ArrowRight')
    await nextTick()
    expect(value.value).toBe(2)
    expect(document.activeElement).toBe(stars(host)[1])
    readonly.value = true
    await nextTick()
    key(stars(host)[1], 'ArrowRight')
    await nextTick()
    expect(value.value).toBe(2)
    expect(document.activeElement).toBe(stars(host)[2])
    disabled.value = true
    await nextTick()
    expect(stars(host).every(s => s.tabIndex === -1)).toBe(true)
  })

  it('mixed: nothing checked, group described as mixed, and any star selects', async () => {
    const value = ref(3)
    const onSelect = vi.fn()
    const host = mount(() => h(PRating, { modelValue: value.value, mixed: true, onSelect }))
    expect(stars(host).some(s => s.getAttribute('aria-checked') === 'true')).toBe(false)
    const group = host.querySelector('[role=radiogroup]')!
    const desc = host.querySelector(`#${CSS.escape(group.getAttribute('aria-describedby')!)}`)
    expect(desc?.textContent).toBeTruthy()
    expect(stars(host)[0].tabIndex).toBe(0)
    key(stars(host)[2], 'Enter')
    expect(onSelect).toHaveBeenCalledWith(3)
  })
})

describe('pslider', () => {
  it('exposes index + valuetext for non-numeric options', () => {
    const host = mount(() => h(PSlider, { options: ['low', 'mid', 'high'], modelValue: 'mid', ariaLabel: 'Q' }))
    const s = host.querySelector('[role=slider]')!
    expect(s.getAttribute('aria-valuemin')).toBe('0')
    expect(s.getAttribute('aria-valuemax')).toBe('2')
    expect(s.getAttribute('aria-valuenow')).toBe('1')
    expect(s.getAttribute('aria-valuetext')).toBe('mid')
  })

  it('keeps numeric values and no valuetext for numeric options', () => {
    const host = mount(() => h(PSlider, { min: 1, max: 16, modelValue: 4, ariaLabel: 'N' }))
    const s = host.querySelector('[role=slider]')!
    expect(s.getAttribute('aria-valuemin')).toBe('1')
    expect(s.getAttribute('aria-valuemax')).toBe('16')
    expect(s.getAttribute('aria-valuenow')).toBe('4')
    expect(s.hasAttribute('aria-valuetext')).toBe(false)
  })
})
