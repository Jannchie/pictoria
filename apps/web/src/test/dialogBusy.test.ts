// @vitest-environment happy-dom
import type { VNode } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import PDialog from '@/ui/PDialog.vue'

async function flush() {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
  }
}

function mount(render: () => VNode) {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({ render }))
  app.mount(root)
  return () => {
    app.unmount()
    root.remove()
  }
}

function press(target: EventTarget, key: string) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === label)!
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  document.body.innerHTML = ''
})

describe('pdialog busy', () => {
  it('blocks every dismissal and re-confirm while busy, and keeps focus inside', async () => {
    const events: string[] = []
    const busy = ref(false)
    cleanup = mount(() => h(PDialog, {
      title: 'Delete?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
      busy: busy.value,
      onConfirm: () => events.push('confirm'),
      onCancel: () => events.push('cancel'),
    }))
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    // Danger dialogs focus Cancel first.
    expect(document.activeElement).toBe(button('Cancel'))

    busy.value = true
    await flush()
    // Cancel is now disabled; focus moved to the (loading) confirm button
    // instead of falling to <body>.
    expect(button('Cancel').disabled).toBe(true)
    expect(document.activeElement).toBe(button('Delete'))
    expect(button('Delete').getAttribute('aria-busy')).toBe('true')
    expect(dialog.getAttribute('aria-busy')).toBe('true')

    press(document.body, 'Escape')
    dialog.focus()
    press(dialog, 'Enter')
    button('Delete').click()
    button('Cancel').click()
    expect(events).toEqual([])

    busy.value = false
    await flush()
    press(document.body, 'Escape')
    expect(events).toEqual(['cancel'])
  })
})
