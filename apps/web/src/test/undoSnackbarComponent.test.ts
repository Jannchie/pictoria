// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import UndoSnackbar from '@/components/UndoSnackbar.vue'
import { i18n, localeSetting } from '@/locale'
import { dismissUndoSnackbar, notifyDid, undoSnackbar } from '@/shared/undoSnackbar'

let unmount: (() => void) | null = null

function mountSnackbar() {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(UndoSnackbar)
  app.use(i18n)
  app.mount(root)
  unmount = () => {
    app.unmount()
    root.remove()
  }
}

async function flush() {
  await nextTick()
  await nextTick()
}

const actionButton = () => document.querySelector<HTMLButtonElement>('button[aria-keyshortcuts]')

describe('undosnackbar component auto-dismiss', () => {
  beforeEach(() => {
    localeSetting.value = 'en'
    vi.useFakeTimers()
    dismissUndoSnackbar()
    mountSnackbar()
  })
  afterEach(() => {
    unmount?.()
    unmount = null
    dismissUndoSnackbar()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('auto-dismisses after the timeout', async () => {
    notifyDid('x')
    await flush()
    vi.advanceTimersByTime(5000)
    expect(undoSnackbar.value).toBeNull()
  })

  it('hovering the action holds it on screen', async () => {
    notifyDid('x')
    await flush()
    actionButton()!.dispatchEvent(new PointerEvent('pointerenter'))
    vi.advanceTimersByTime(10_000)
    expect(undoSnackbar.value).not.toBeNull()
  })

  it('the hover hold ends when the hovered button is replaced by an action-less error', async () => {
    notifyDid('x')
    await flush()
    actionButton()!.dispatchEvent(new PointerEvent('pointerenter'))
    // A failed undo: same card, no button — no pointerleave ever fires.
    undoSnackbar.value = { message: 'cannot undo', action: null, tone: 'error', id: 9999 }
    await flush()
    expect(actionButton()).toBeNull()
    vi.advanceTimersByTime(5000)
    expect(undoSnackbar.value).toBeNull()
  })

  it('a dismissed hovered snackbar does not pin the next one', async () => {
    notifyDid('x')
    await flush()
    actionButton()!.dispatchEvent(new PointerEvent('pointerenter'))
    dismissUndoSnackbar() // Escape
    await flush()
    notifyDid('y')
    await flush()
    vi.advanceTimersByTime(5000)
    expect(undoSnackbar.value).toBeNull()
  })
})
