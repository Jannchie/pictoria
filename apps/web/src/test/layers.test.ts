// @vitest-environment happy-dom
import type { LayerHandle } from '@/shared/layers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { hasModalLayer, isTopLayer, layerCount, pushLayer, topLayer, useLayer } from '@/shared/layers'
import { isAnyDialogOpen } from '@/ui/modal'

function byId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!
}

const handles: LayerHandle[] = []
function push(...args: Parameters<typeof pushLayer>): LayerHandle {
  const h = pushLayer(...args)
  handles.push(h)
  return h
}

function esc(target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

function pointerdown(target: EventTarget): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
}

let app: HTMLElement
let portal: HTMLElement
let toast: HTMLElement

beforeEach(() => {
  document.body.innerHTML = `
    <div id="app"><button id="trigger">t</button><div id="inline-layer"></div></div>
    <div id="portal"><div id="dialog"><button id="in-dialog">x</button></div></div>
    <div id="toasts" data-layer-keep-active></div>
    <div id="foreign" inert></div>
    <div id="other"></div>`
  app = byId('app')
  portal = byId('portal')
  toast = byId('toasts')
})

afterEach(() => {
  for (const h of handles.splice(0)) {
    h.remove()
  }
})

describe('layer stack', () => {
  it('tracks count, top and modal state', () => {
    expect(layerCount.value).toBe(0)
    const a = push({ el: () => null })
    const b = push({ el: () => null, modal: true })
    expect(layerCount.value).toBe(2)
    expect(topLayer()?.id).toBe(b.id)
    expect(isTopLayer(a.id)).toBe(false)
    expect(b.isTop()).toBe(true)
    expect(hasModalLayer.value).toBe(true)
    expect(isAnyDialogOpen.value).toBe(true)
    b.remove()
    b.remove() // idempotent
    expect(a.isTop()).toBe(true)
    expect(hasModalLayer.value).toBe(false)
    expect(isAnyDialogOpen.value).toBe(false)
  })
})

describe('escape', () => {
  it('only the top layer handles it, and nothing below sees it', () => {
    const lower = vi.fn()
    const upper = vi.fn()
    const windowListener = vi.fn()
    globalThis.addEventListener('keydown', windowListener)
    push({ el: () => null, onEscape: lower })
    const top = push({ el: () => null, onEscape: upper })
    const e = esc(byId('in-dialog'))
    expect(upper).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
    expect(windowListener).not.toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(true)
    top.remove()
    esc()
    expect(lower).toHaveBeenCalledTimes(1)
    globalThis.removeEventListener('keydown', windowListener)
  })

  it('swallows escape even when the top layer has no onescape', () => {
    const windowListener = vi.fn()
    globalThis.addEventListener('keydown', windowListener)
    push({ el: () => null })
    esc()
    expect(windowListener).not.toHaveBeenCalled()
    globalThis.removeEventListener('keydown', windowListener)
  })

  it('lets escape through when the stack is empty, while composing, or from a passthrough zone', () => {
    const windowListener = vi.fn()
    globalThis.addEventListener('keydown', windowListener)
    esc()
    expect(windowListener).toHaveBeenCalledTimes(1)

    const onEscape = vi.fn()
    push({ el: () => null, onEscape })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }))
    expect(onEscape).not.toHaveBeenCalled()
    expect(windowListener).toHaveBeenCalledTimes(2)

    const zone = document.createElement('div')
    zone.dataset.layerEscapePassthrough = ''
    const input = document.createElement('input')
    zone.append(input)
    document.body.append(zone)
    esc(input)
    expect(onEscape).not.toHaveBeenCalled()
    expect(windowListener).toHaveBeenCalledTimes(3)
    globalThis.removeEventListener('keydown', windowListener)
  })

  it('ignores other keys', () => {
    const onEscape = vi.fn()
    push({ el: () => null, onEscape })
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(onEscape).not.toHaveBeenCalled()
  })
})

describe('outside pointerdown', () => {
  it('fires for the top layer only when outside el and inside()', () => {
    const lower = vi.fn()
    const outside = vi.fn()
    const dialog = byId('dialog')
    const trigger = byId('trigger')
    push({ el: () => null, onPointerDownOutside: lower })
    push({ el: () => dialog, inside: () => [trigger], onPointerDownOutside: outside })
    pointerdown(byId('in-dialog'))
    pointerdown(trigger)
    expect(outside).not.toHaveBeenCalled()
    pointerdown(byId('other'))
    expect(outside).toHaveBeenCalledTimes(1)
    expect(lower).not.toHaveBeenCalled()
  })
})

describe('inert', () => {
  it('inerts body children outside a teleported modal and restores exactly', () => {
    const other = byId('other')
    const foreign = byId('foreign')
    const h = push({ el: () => byId('dialog'), modal: true })
    expect(app.hasAttribute('inert')).toBe(true)
    expect(other.hasAttribute('inert')).toBe(true)
    expect(portal.hasAttribute('inert')).toBe(false)
    expect(toast.hasAttribute('inert')).toBe(false) // data-layer-keep-active
    h.remove()
    expect(app.hasAttribute('inert')).toBe(false)
    expect(other.hasAttribute('inert')).toBe(false)
    expect(foreign.hasAttribute('inert')).toBe(true) // someone else's inert survives
  })

  it('keeps layers stacked above the modal active', () => {
    const popup = document.createElement('div')
    popup.id = 'popup'
    document.body.append(popup)
    push({ el: () => byId('dialog'), modal: true })
    const p = push({ el: () => popup })
    expect(popup.hasAttribute('inert')).toBe(false)
    expect(app.hasAttribute('inert')).toBe(true)
    p.remove()
    expect(popup.hasAttribute('inert')).toBe(true)
  })

  it('skips inert for a modal rendered inside #app and for non-modal layers', () => {
    push({ el: () => byId('inline-layer'), modal: true })
    expect(byId('other').hasAttribute('inert')).toBe(false)
    push({ el: () => byId('dialog') })
    expect(app.hasAttribute('inert')).toBe(false)
  })

  it('honours inertothers: true on a non-modal layer', () => {
    push({ el: () => byId('dialog'), inertOthers: true })
    expect(hasModalLayer.value).toBe(false)
    expect(app.hasAttribute('inert')).toBe(true)
  })
})

describe('uselayer', () => {
  it('pushes while active and pops on false / dispose', async () => {
    const open = ref(false)
    const scope = effectScope()
    const { isTop } = scope.run(() => useLayer(open, { el: () => null, modal: true }))!
    await nextTick()
    expect(layerCount.value).toBe(0)
    open.value = true
    await nextTick()
    expect(layerCount.value).toBe(1)
    expect(isTop.value).toBe(true)
    const other = push({ el: () => null })
    expect(isTop.value).toBe(false)
    other.remove()
    open.value = false
    await nextTick()
    expect(layerCount.value).toBe(0)
    expect(isTop.value).toBe(false)
    open.value = true
    await nextTick()
    expect(layerCount.value).toBe(1)
    scope.stop()
    expect(layerCount.value).toBe(0)
  })
})
