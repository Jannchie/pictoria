// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { allowsViewKeys, clampScale, isInteractiveTarget, isPlainButton, MAX_SCALE, MIN_PAN_STEP, MIN_SCALE, panOffset } from '@/utils/postViewerKeys'

function byId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`#${id}`)!
}

function mount(html: string): void {
  document.body.innerHTML = html
}

describe('isplainbutton', () => {
  it('accepts native buttons outside composites', () => {
    mount(`<button id="a">a</button><button id="b" role="button">b</button>`)
    expect(isPlainButton(byId('a'))).toBe(true)
    expect(isPlainButton(byId('b'))).toBe(true)
  })

  it('rejects non-buttons, buttons with another role, and buttons inside composites', () => {
    mount(`
      <div id="div" role="button" tabindex="0">d</div>
      <button id="radio" role="radio">r</button>
      <div role="radiogroup"><button id="inGroup">g</button></div>
      <div role="listbox"><button id="inList">l</button></div>
      <div role="toolbar"><button id="inToolbar">t</button></div>
    `)
    for (const id of ['div', 'radio', 'inGroup', 'inList', 'inToolbar']) {
      expect(isPlainButton(byId(id)), id).toBe(false)
    }
    expect(isPlainButton(null)).toBe(false)
  })
})

describe('allowsviewkeys', () => {
  it('allows non-widget targets anywhere', () => {
    mount(`<div id="chrome"></div><div id="img" tabindex="0" role="img"></div>`)
    expect(allowsViewKeys(document.body, byId('chrome'))).toBe(true)
    expect(allowsViewKeys(byId('img'), byId('chrome'))).toBe(true)
  })

  it('allows plain buttons only inside the view chrome', () => {
    mount(`<div id="chrome"><button id="rail">next</button></div><button id="outside">x</button>`)
    expect(allowsViewKeys(byId('rail'), byId('chrome'))).toBe(true)
    expect(allowsViewKeys(byId('outside'), byId('chrome'))).toBe(false)
    expect(allowsViewKeys(byId('rail'), null)).toBe(false)
  })

  it('rejects value widgets and composite items even inside the chrome', () => {
    mount(`<div id="chrome">
      <div id="slider" role="slider" tabindex="0"></div>
      <div role="listbox"><div id="option" role="option" tabindex="0"></div></div>
      <div role="radiogroup"><button id="star" role="radio"></button></div>
      <div id="thumb" role="button" tabindex="0"></div>
    </div>`)
    for (const id of ['slider', 'option', 'star', 'thumb']) {
      expect(allowsViewKeys(byId(id), byId('chrome')), id).toBe(false)
    }
  })
})

describe('isinteractivetarget', () => {
  it('counts widgets plus non-native role=button / role=link, not role=img', () => {
    mount(`
      <button id="btn">b</button>
      <div id="thumb" role="button" tabindex="0"><span id="inner">x</span></div>
      <span id="link" role="link" tabindex="0">l</span>
      <div id="img" role="img" tabindex="0"></div>
    `)
    for (const id of ['btn', 'thumb', 'inner', 'link']) {
      expect(isInteractiveTarget(byId(id)), id).toBe(true)
    }
    expect(isInteractiveTarget(byId('img'))).toBe(false)
    expect(isInteractiveTarget(document.body)).toBe(false)
  })
})

describe('clampscale', () => {
  it('clamps to the zoom range and rounds to 0.01', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(1.2345)).toBe(1.23)
  })
})

describe('panoffset', () => {
  it('moves the image opposite to the arrow, 10% of the viewport', () => {
    expect(panOffset('ArrowRight', 1000, 500)).toEqual({ dx: -100, dy: 0 })
    expect(panOffset('ArrowLeft', 1000, 500)).toEqual({ dx: 100, dy: 0 })
    expect(panOffset('ArrowDown', 1000, 500)).toEqual({ dx: 0, dy: -50 })
    expect(panOffset('ArrowUp', 1000, 500)).toEqual({ dx: 0, dy: 50 })
  })

  it('uses a minimum step for tiny viewports and ignores other keys', () => {
    expect(panOffset('ArrowLeft', 10, 10)).toEqual({ dx: MIN_PAN_STEP, dy: 0 })
    expect(panOffset('Enter', 1000, 500)).toBeNull()
  })
})
