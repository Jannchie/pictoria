// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { provideGalleryTiles, useViewportHiRes } from '@/composables/useViewportHiRes'

// One IntersectionObserver per grid, not per tile; visibility + the shared
// tile width decide whether a tile asks for its original.

class FakeIO {
  static instances: FakeIO[] = []
  observed = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIO.instances.push(this)
  }

  observe(el: Element) {
    this.observed.add(el)
  }

  unobserve(el: Element) {
    this.observed.delete(el)
  }

  disconnect() {
    this.observed.clear()
  }

  fire(el: Element, isIntersecting: boolean) {
    this.callback([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

const post = (id: number) => ({ filePath: 'a', fileName: `p${id}`, extension: 'png', width: 4000 })

let app: App | undefined
const srcs = new Map<number, { value: string }>()
const tileWidth = ref(800)
const shown = ref([1, 2, 3])

const Tile = defineComponent({
  props: { id: { type: Number, required: true } },
  setup(props) {
    const el = ref<HTMLElement | null>(null)
    const { src } = useViewportHiRes(el, () => post(props.id))
    srcs.set(props.id, src)
    return () => h('div', { 'ref': el, 'data-id': props.id })
  },
})
const renderTile = (id: number) => h(Tile, { key: id, id })
const renderGrid = () => h('div', shown.value.map(renderTile))
const Grid = defineComponent({
  setup() {
    provideGalleryTiles(tileWidth)
    return renderGrid
  },
})

function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  app = createApp(Grid)
  app.mount(host)
  return host
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeIO.instances = []
  vi.stubGlobal('IntersectionObserver', FakeIO)
  srcs.clear()
  tileWidth.value = 800
  shown.value = [1, 2, 3]
})

afterEach(() => {
  app?.unmount()
  app = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('providegallerytiles', () => {
  it('observes every tile through one shared observer', async () => {
    mount()
    await nextTick()
    expect(FakeIO.instances).toHaveLength(1)
    expect(FakeIO.instances[0]!.observed.size).toBe(3)
  })

  it('unobserves a tile when it unmounts', async () => {
    mount()
    await nextTick()
    shown.value = [1]
    await nextTick()
    expect(FakeIO.instances[0]!.observed.size).toBe(1)
  })

  it('swaps to the original only while visible, after the dwell', async () => {
    const loads: string[] = []
    vi.stubGlobal('Image', class {
      decoding = ''
      private url = ''
      get src() {
        return this.url
      }

      set src(url: string) {
        this.url = url
        if (url) {
          loads.push(url)
        }
      }

      decode() {
        return Promise.resolve()
      }
    })
    const host = mount()
    await nextTick()
    const io = FakeIO.instances[0]!
    const el = host.querySelector('[data-id="1"]')!
    const thumb = srcs.get(1)!.value

    io.fire(el, true)
    await nextTick()
    vi.advanceTimersByTime(149)
    expect(loads).toEqual([])
    vi.advanceTimersByTime(1)
    expect(loads).toHaveLength(1)
    await vi.waitFor(() => expect(srcs.get(1)!.value).not.toBe(thumb))
    expect(srcs.get(1)!.value).toBe(loads[0])

    // The shared width shrinks below the thumbnail: every tile drops back.
    tileWidth.value = 100
    await nextTick()
    expect(srcs.get(1)!.value).toBe(thumb)

    // A tile that never became visible never loads its original.
    tileWidth.value = 800
    await nextTick()
    vi.advanceTimersByTime(500)
    expect(loads.filter(u => u.includes('p2'))).toEqual([])
  })
})
