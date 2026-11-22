// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import PKbd from '@/ui/PKbd.vue'
import PSegmented from '@/ui/PSegmented.vue'

const cleanups: (() => void)[] = []

function mount(render: () => ReturnType<typeof h>) {
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render })
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

// useRovingFocus syncs tabindex in a post-flush watcher, then on a microtask.
async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c()
  }
})

describe('pkbd', () => {
  it('renders a raised keycap by default, with the md size as a modifier', () => {
    const host = mount(() => h('div', [
      h(PKbd, () => 'Esc'),
      h(PKbd, { size: 'md' }, () => 'Space'),
    ]))
    const [sm, md] = host.querySelectorAll('kbd')
    expect(sm.textContent).toBe('Esc')
    expect(sm.classList.contains('p-kbd')).toBe(true)
    expect(sm.classList.contains('p-kbd--md')).toBe(false)
    expect(md.classList.contains('p-kbd--md')).toBe(true)
  })

  it('renders the flat cap with its utility classes and lets attrs fall through', () => {
    const host = mount(() => h(PKbd, { 'variant': 'flat', 'class': 'shrink-0', 'aria-hidden': 'true' }, () => 'Ctrl K'))
    const kbd = host.querySelector('kbd')!
    expect(kbd.classList.contains('p-kbd')).toBe(false)
    expect(kbd.classList.contains('border-border-subtle')).toBe(true)
    expect(kbd.classList.contains('shrink-0')).toBe(true)
    expect(kbd.getAttribute('aria-hidden')).toBe('true')
  })

  it('ignores size on a flat cap', () => {
    const host = mount(() => h(PKbd, { variant: 'flat', size: 'md' }, () => 'K'))
    expect(host.querySelector('kbd')!.classList.contains('p-kbd--md')).toBe(false)
  })
})

describe('psegmented', () => {
  const OPTIONS = [
    { value: 'a', label: 'Alpha', title: 'First' },
    { value: 'b', label: 'Beta', title: 'Second' },
    { value: 'c', label: 'Gamma', title: 'Third' },
  ]

  function mountSegmented(initial = 'b') {
    const model = ref(initial)
    const host = mount(() => h(PSegmented, {
      'options': OPTIONS,
      'modelValue': model.value,
      'onUpdate:modelValue': (v: string | number) => {
        model.value = String(v)
      },
      'aria-labelledby': 'label-id',
      'aria-describedby': 'hint-id',
    }))
    const group = host.querySelector<HTMLElement>('[role=radiogroup]')!
    const radios = () => [...group.querySelectorAll<HTMLElement>('[role=radio]')]
    return { model, group, radios }
  }

  it('renders a labelled radio group with one checked segment', async () => {
    const { group, radios } = mountSegmented()
    await settle()
    expect(group.getAttribute('aria-labelledby')).toBe('label-id')
    expect(group.getAttribute('aria-describedby')).toBe('hint-id')
    expect(radios().map(r => r.textContent?.trim())).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(radios().map(r => r.getAttribute('title'))).toEqual(['First', 'Second', 'Third'])
    expect(radios().map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios()[1]!.classList.contains('p-segmented__item--active')).toBe(true)
  })

  it('is one tab stop: the checked segment', async () => {
    const { radios } = mountSegmented()
    await settle()
    expect(radios().map(r => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('selects on click', async () => {
    const { model, radios } = mountSegmented()
    radios()[2]!.click()
    await settle()
    expect(model.value).toBe('c')
    expect(radios()[2]!.getAttribute('aria-checked')).toBe('true')
  })

  it('arrows move focus and select, wrapping at the ends', async () => {
    const { model, radios } = mountSegmented()
    await settle()
    radios()[1]!.focus()
    key(radios()[1]!, 'ArrowRight')
    await settle()
    expect(model.value).toBe('c')
    expect(document.activeElement).toBe(radios()[2])
    key(radios()[2]!, 'ArrowRight')
    await settle()
    expect(model.value).toBe('a')
    expect(document.activeElement).toBe(radios()[0])
    key(radios()[0]!, 'ArrowLeft')
    await settle()
    expect(model.value).toBe('c')
  })

  it('home / end jump to the first / last segment', async () => {
    const { model, radios } = mountSegmented()
    await settle()
    radios()[1]!.focus()
    key(radios()[1]!, 'End')
    await settle()
    expect(model.value).toBe('c')
    key(radios()[2]!, 'Home')
    await settle()
    expect(model.value).toBe('a')
  })

  it('leaves vertical arrows alone (horizontal group)', async () => {
    const { model, radios } = mountSegmented()
    await settle()
    radios()[1]!.focus()
    const e = key(radios()[1]!, 'ArrowDown')
    await settle()
    expect(e.defaultPrevented).toBe(false)
    expect(model.value).toBe('b')
  })
})
