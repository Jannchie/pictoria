import type { Component } from 'vue'
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import FacetFilterPopover from '@/components/FacetFilterPopover.vue'
import { formatPct, useFacetCounts } from '@/composables/useFacetFilter'
import { i18n, localeSetting } from '@/locale'

async function flush() {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
  }
}

const NAMES: Record<string, string> = { a: 'Alpha', b: 'Beta', c: 'Gamma' }

interface Row { key: string, count: number }

/** A facet over a, b, c with the shell wired the way the filters wire it. */
function mountFacet(opts: { rows?: Row[], selected?: string[], props?: Record<string, unknown> } = {}) {
  const rows = ref<Row[] | undefined>(opts.rows)
  const selected = ref<string[]>(opts.selected ?? [])
  const opened = ref(true)
  const counts = useFacetCounts(rows, r => r.key)
  const total = () => (rows.value ?? []).reduce((n, r) => n + r.count, 0)
  const Host = defineComponent({
    // A generic SFC doesn't fit h()'s component overloads; the props are checked at runtime here.
    render: () => h(FacetFilterPopover as Component, {
      'label': 'Letter',
      'items': ['a', 'b', 'c'],
      'selection': selected.value,
      'has': (v: string) => selected.value.includes(v),
      'valueName': (v: string) => NAMES[v]!,
      'count': counts.count,
      'optionCount': counts.optionCount,
      'share': (n: number) => formatPct(n, total()),
      'icon': 'i-test',
      'opened': opened.value,
      'onUpdate:opened': (v: boolean) => {
        opened.value = v
      },
      'onToggle': (v: string) => {
        selected.value = selected.value.includes(v) ? selected.value.filter(x => x !== v) : [...selected.value, v]
      },
      ...opts.props,
    }, {
      default: ({ item }: { item: string }) => h('span', { class: 'row' }, item),
    }),
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(Host)
  app.use(i18n)
  app.mount(root)
  return {
    rows,
    selected,
    opened,
    trigger: () => root.querySelector<HTMLButtonElement>('button')!,
    options: () => [...document.querySelectorAll<HTMLElement>('[role=option]')],
    unmount: () => {
      app.unmount()
      root.remove()
    },
  }
}

let current: ReturnType<typeof mountFacet> | null = null
function mounted(opts?: Parameters<typeof mountFacet>[0]) {
  current = mountFacet(opts)
  return current
}

beforeEach(() => {
  localeSetting.value = 'en'
})
afterEach(() => {
  current?.unmount()
  current = null
  document.body.innerHTML = ''
})

describe('facetfilterpopover trigger', () => {
  it('shows the facet name at rest', async () => {
    const f = mounted()
    await flush()
    expect(f.trigger().getAttribute('aria-label')).toBe('Letter')
    expect(f.trigger().textContent?.trim()).toBe('Letter')
    expect(f.trigger().querySelector('i.i-test')).toBeTruthy()
  })

  it('names one and many selected values, in selection order', async () => {
    const f = mounted({ selected: ['b'] })
    await flush()
    expect(f.trigger().getAttribute('aria-label')).toBe('Letter: Beta')
    expect(f.trigger().textContent?.trim()).toBe('Beta')

    f.selected.value = ['c', 'a']
    await flush()
    expect(f.trigger().getAttribute('aria-label')).toBe('Letter: Gamma, Alpha')
    expect(f.trigger().textContent?.trim()).toBe('Gamma, Alpha')
  })

  it('visible text can differ from the spoken name and carry a prefix', async () => {
    const f = mounted({ selected: ['a', 'c'], props: { valueText: String, chipPrefix: 'L' } })
    await flush()
    expect(f.trigger().textContent?.trim()).toBe('L: a, c')
    expect(f.trigger().getAttribute('aria-label')).toBe('Letter: Alpha, Gamma')
  })
})

describe('facetfilterpopover listbox', () => {
  it('renders every option with its count and share', async () => {
    const f = mounted({ rows: [{ key: 'a', count: 3 }, { key: 'b', count: 1 }] })
    await flush()
    const options = f.options()
    expect(options.map(o => o.querySelector('.row')?.textContent)).toEqual(['a', 'b', 'c'])
    expect(options.map(o => o.getAttribute('aria-label'))).toEqual(['Alpha, 3 posts', 'Beta, 1 post', 'Gamma, 0 posts'])
    expect(options[0]!.textContent).toContain('75.0%')
    expect(options[1]!.textContent).toContain('25.0%')
    expect(options.map(o => o.dataset.typeahead)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(document.querySelector('[role=listbox]')?.getAttribute('aria-label')).toBe('Letter')
  })

  it('speaks no count before the counts load', async () => {
    const f = mounted()
    await flush()
    expect(f.options().map(o => o.getAttribute('aria-label'))).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('toggling an option updates the selection and the trigger', async () => {
    const f = mounted({ rows: [{ key: 'a', count: 3 }] })
    await flush()
    f.options()[1]!.click()
    await flush()
    expect(f.selected.value).toEqual(['b'])
    expect(f.options()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(f.trigger().getAttribute('aria-label')).toBe('Letter: Beta')
    f.options()[1]!.click()
    await flush()
    expect(f.selected.value).toEqual([])
  })

  it('autofocuses the first selected option', async () => {
    const f = mounted({ selected: ['c'] })
    await flush()
    expect(f.options().map(o => 'autofocus' in o.dataset)).toEqual([false, false, true])
  })

  it('maps object rows to values through itemvalue', async () => {
    const f = mounted({
      rows: [{ key: 'b', count: 2 }],
      props: {
        items: [{ level: 'a' }, { level: 'b' }],
        itemKey: (i: { level: string }) => i.level,
        itemValue: (i: { level: string }) => i.level,
        optionName: (i: { level: string }) => `Level ${i.level}`,
      },
    })
    await flush()
    expect(f.options().map(o => o.getAttribute('aria-label'))).toEqual(['Level a, 0 posts', 'Level b, 2 posts'])
    expect(f.options().map(o => o.dataset.typeahead)).toEqual(['Alpha', 'Beta'])
    f.options()[0]!.click()
    await flush()
    expect(f.selected.value).toEqual(['a'])
  })
})

describe('usefacetcounts', () => {
  it('looks counts up by value; the last row for a value wins', () => {
    const rows = ref<Row[] | undefined>([{ key: 'a', count: 1 }, { key: 'a', count: 4 }])
    const { count, optionCount } = useFacetCounts(rows, r => r.key)
    expect(count('a')).toBe(4)
    expect(count('z')).toBeUndefined()
    expect(optionCount('z')).toBe(0)
  })

  it('has no option count until the rows load', () => {
    const rows = ref<Row[] | undefined>(undefined)
    const { count, optionCount } = useFacetCounts(rows, r => r.key)
    expect(count('a')).toBeUndefined()
    expect(optionCount('a')).toBeUndefined()
    rows.value = []
    expect(optionCount('a')).toBe(0)
  })
})
