// @vitest-environment happy-dom
import type { App } from 'vue'
import type { GridRect } from '@/utils/gridGeometry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { galleryGridKey, useGalleryGrid } from '@/composables/useGalleryGrid'
import { i18n } from '@/locale'
import { clear, commitPendingSelection, gridCursorId, selectedIdList, setGridCursor } from '@/shared/selection'
import { isMac } from '@/utils/keyboard'

// A 3×3 grid, ids row-major:
//   1 2 3
//   4 5 6
//   7 8 9
const IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const LAYOUT: GridRect[] = IDS.map((_, i) => ({ x: (i % 3) * 120, y: Math.floor(i / 3) * 120, width: 100, height: 100 }))

const Item = defineComponent({
  props: { id: { type: Number, required: true } },
  setup(props) {
    const grid = inject(galleryGridKey, null)
    onMounted(() => grid?.register(props.id))
    onBeforeUnmount(() => grid?.unregister(props.id))
    return () => h('div', { id: `post-item-${props.id}`, role: 'option' })
  },
})

let app: App | undefined
let host: HTMLElement
let container: HTMLElement
let outside: ReturnType<typeof useGalleryGrid>
const open = vi.fn()
const requestDelete = vi.fn()

function mount() {
  host = document.createElement('div')
  document.body.append(host)
  const Harness = defineComponent({
    setup() {
      const el = ref<HTMLElement | null>(null)
      const scroller = ref<HTMLElement | null>(null)
      const ids = ref(IDS)
      outside = useGalleryGrid({
        container: el,
        scroller,
        ids,
        layout: () => LAYOUT,
        open,
        requestDelete,
        contextMenu: true,
      })
      return () => h('div', { ref: scroller }, [
        h('div', { 'ref': el, 'role': 'listbox', 'tabindex': 0, 'aria-multiselectable': 'true' }, IDS.map(id => h(Item, { id, key: id }))),
      ])
    },
  })
  app = createApp(Harness)
  app.use(i18n)
  app.mount(host)
  container = host.querySelector<HTMLElement>('[role=listbox]')!
}

function key(k: string, mods: { shift?: boolean, mod?: boolean, ctrl?: boolean } = {}, target: EventTarget = container): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    shiftKey: mods.shift ?? false,
    ctrlKey: mods.ctrl ?? (mods.mod === true && !isMac),
    metaKey: mods.mod === true && isMac,
  })
  target.dispatchEvent(e)
  return e
}

function selected(): number[] {
  return [...selectedIdList.value].sort((a, b) => a - b)
}

beforeEach(async () => {
  commitPendingSelection()
  clear()
  setGridCursor(null)
  open.mockClear()
  requestDelete.mockClear()
  mount()
  await nextTick()
  container.focus()
  await nextTick()
})

afterEach(() => {
  app?.unmount()
  host.remove()
  app = undefined
})

describe('usegallerygrid — keyboard model', () => {
  it('seeds the cursor on keyboard focus without selecting', () => {
    expect(gridCursorId.value).toBe(1)
    expect(selected()).toEqual([])
  })

  it('arrows move the cursor and select only the target', async () => {
    const e = key('ArrowRight')
    expect(e.defaultPrevented).toBe(true)
    key('ArrowDown')
    expect(gridCursorId.value).toBe(5)
    expect(selected()).toEqual([5])
    await nextTick()
    expect(container.getAttribute('aria-activedescendant')).toBe('post-item-5')
  })

  it('shift+arrows extend a range from the anchor, and shrink it back', () => {
    key('ArrowRight')
    key('ArrowRight', { shift: true })
    key('ArrowDown', { shift: true })
    expect(selected()).toEqual([2, 3, 4, 5, 6])
    key('ArrowUp', { shift: true })
    expect(selected()).toEqual([2, 3])
  })

  it('mod+arrows move the cursor only; space toggles; shift+space selects the range', () => {
    key('ArrowRight')
    key('ArrowDown', { mod: true })
    expect(gridCursorId.value).toBe(5)
    expect(selected()).toEqual([2])
    key(' ')
    expect(selected()).toEqual([2, 5])
    key(' ', { ctrl: true })
    expect(selected()).toEqual([2])
    key('ArrowRight', { mod: true })
    key(' ', { shift: true })
    expect(selected()).toEqual([2, 5, 6])
  })

  it('home / end jump to the first / last post', () => {
    key('End')
    expect(selected()).toEqual([9])
    key('Home', { shift: true })
    expect(selected()).toEqual(IDS)
  })

  it('enter opens the cursor post; delete asks to delete; mod+a selects all; escape clears', () => {
    key('ArrowDown')
    key('Enter')
    expect(open).toHaveBeenCalledWith(4)
    key('Delete')
    expect(requestDelete).toHaveBeenCalledTimes(1)
    key('a', { mod: true })
    expect(selected()).toEqual(IDS)
    const esc = key('Escape')
    expect(esc.defaultPrevented).toBe(true)
    expect(selected()).toEqual([])
    // Nothing left to clear: Escape falls through to the page.
    expect(key('Escape').defaultPrevented).toBe(false)
  })

  it('shift+f10 opens the context menu on the cursor item', () => {
    key('ArrowRight')
    const onMenu = vi.fn()
    host.addEventListener('contextmenu', onMenu)
    key('F10', { shift: true })
    expect(onMenu).toHaveBeenCalledTimes(1)
    expect((onMenu.mock.calls[0][0] as MouseEvent).target).toBe(host.querySelector('#post-item-2'))
    expect(selected()).toEqual([2])
  })

  it('from outside the grid, an arrow moves focus into the grid', () => {
    container.blur()
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    document.body.dispatchEvent(e)
    expect(outside.handleOutsideKey(e)).toBe(true)
    expect(document.activeElement).toBe(container)
    expect(selected()).toEqual([4])
  })

  it('leaves foreign widgets alone when called from outside', () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    const e = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    button.dispatchEvent(e)
    expect(outside.handleOutsideKey(e)).toBe(false)
    button.remove()
  })
})
