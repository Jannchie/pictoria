// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useFocusReturn, useFocusTrap } from '@/composables/useFocusTrap'
import { focusElement, focusFirst, getFocusable } from '@/utils/focus'

function byId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return byId('c')
}

const ids = (els: HTMLElement[]) => els.map(e => e.id)
const flushMicrotasks = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function tab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e
}

describe('getfocusable', () => {
  it('returns tabbables in tab order, skipping disabled / hidden / inert / tabindex=-1', () => {
    const c = mount(`<div id="c">
      <button id="b1">1</button>
      <button id="dis" disabled>x</button>
      <a id="nohref">x</a>
      <a id="link" href="#">l</a>
      <input id="hidden" type="hidden">
      <div id="minus" tabindex="-1">x</div>
      <div id="zero" tabindex="0">x</div>
      <button id="gone" style="display:none">x</button>
      <div inert><button id="inert">x</button></div>
      <button id="pos2" tabindex="2">p2</button>
      <button id="pos1" tabindex="1">p1</button>
      <div id="ce" contenteditable="true"></div>
    </div>`)
    expect(ids(getFocusable(c))).toEqual(['pos1', 'pos2', 'b1', 'link', 'zero', 'ce'])
  })

  it('keeps only the checked (or first) radio of a native group', () => {
    const c = mount(`<div id="c">
      <input id="r1" type="radio" name="g"><input id="r2" type="radio" name="g" checked>
      <input id="s1" type="radio" name="h"><input id="s2" type="radio" name="h">
    </div>`)
    expect(ids(getFocusable(c))).toEqual(['r2', 's1'])
  })

  it('handles an empty / missing container', () => {
    expect(getFocusable(null)).toEqual([])
    expect(focusFirst(mount('<div id="c"><span>x</span></div>'))).toBe(false)
  })

  it('focuselement reports whether focus landed', () => {
    const c = mount('<div id="c"><button id="b">b</button></div>')
    expect(focusElement(c.querySelector('button'))).toBe(true)
    expect(focusElement(null)).toBe(false)
  })
})

describe('usefocustrap', () => {
  it('moves focus in, cycles tab, and returns focus on deactivate', async () => {
    document.body.innerHTML = `<button id="opener">o</button>
      <div id="c"><button id="first">1</button><button id="last">2</button></div>`
    const opener = byId('opener')
    const c = byId('c')
    opener.focus()
    const active = ref(false)
    const scope = effectScope()
    scope.run(() => useFocusTrap(() => c, active))
    active.value = true
    await nextTick()
    expect(document.activeElement?.id).toBe('first')

    const last = byId('last')
    last.focus()
    expect(tab(last).defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('first')
    expect(tab(byId('first'), true).defaultPrevented).toBe(true)
    expect(document.activeElement?.id).toBe('last')
    // Middle-of-list Tab is left to the browser.
    byId('first').focus()
    expect(tab(byId('first')).defaultPrevented).toBe(false)

    active.value = false
    await nextTick()
    await flushMicrotasks()
    expect(document.activeElement).toBe(opener)
    scope.stop()
  })

  it('prefers initialfocus, then [data-autofocus], then the container', async () => {
    document.body.innerHTML = `<div id="c"><button id="a">a</button><button id="auto" data-autofocus>b</button><button id="pick">c</button></div>
      <div id="empty"><span>nothing</span></div>`
    const c = byId('c')
    const scope = effectScope()
    const on1 = ref(true)
    scope.run(() => useFocusTrap(() => c, on1, { initialFocus: () => byId('pick') }))
    await nextTick()
    expect(document.activeElement?.id).toBe('pick')
    scope.stop()
    await flushMicrotasks() // let scope 1's focus return settle first

    ;(document.activeElement as HTMLElement).blur()
    const scope2 = effectScope()
    scope2.run(() => useFocusTrap(() => c, true))
    await nextTick()
    expect(document.activeElement?.id).toBe('auto')
    scope2.stop()

    const empty = byId('empty')
    const scope3 = effectScope()
    scope3.run(() => useFocusTrap(() => empty, true))
    await nextTick()
    expect(document.activeElement).toBe(empty)
    expect(empty.getAttribute('tabindex')).toBe('-1')
    scope3.stop()
  })

  it('does not steal focus back when it moved elsewhere on purpose', async () => {
    document.body.innerHTML = `<button id="opener">o</button><input id="elsewhere">
      <div id="c"><button id="inside">1</button></div>`
    byId('opener').focus()
    const c = byId('c')
    const active = ref(true)
    const scope = effectScope()
    scope.run(() => useFocusTrap(() => c, active))
    await nextTick()
    expect(document.activeElement?.id).toBe('inside')
    byId('elsewhere').focus()
    active.value = false
    await nextTick()
    await flushMicrotasks()
    expect(document.activeElement?.id).toBe('elsewhere')
    scope.stop()
  })

  it('falls back to returnfocus() when the opener is gone', async () => {
    document.body.innerHTML = `<button id="opener">o</button><button id="fallback">f</button>
      <div id="c"><button id="inside">1</button></div>`
    const opener = byId('opener')
    opener.focus()
    const c = byId('c')
    const active = ref(true)
    const scope = effectScope()
    scope.run(() => useFocusTrap(() => c, active, { returnFocus: () => byId('fallback') }))
    await nextTick()
    opener.remove()
    c.remove() // layer unmounted → focus drops to body
    active.value = false
    await nextTick()
    await flushMicrotasks()
    expect(document.activeElement?.id).toBe('fallback')
    scope.stop()
  })
})

describe('usefocusreturn', () => {
  it('returns focus when a non-modal layer closes, also on dispose', async () => {
    document.body.innerHTML = `<button id="opener">o</button><div id="pop"><button id="inside">1</button></div>`
    const opener = byId('opener')
    const pop = byId('pop')
    opener.focus()
    const scope = effectScope()
    scope.run(() => useFocusReturn(true, { container: pop }))
    byId('inside').focus()
    scope.stop()
    await flushMicrotasks()
    expect(document.activeElement).toBe(opener)
  })
})
