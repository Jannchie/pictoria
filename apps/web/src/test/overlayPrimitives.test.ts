import type { VNode } from 'vue'
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { layerCount } from '@/shared/layers'
import PDialog from '@/ui/PDialog.vue'
import PMenu from '@/ui/PMenu.vue'
import PPopover from '@/ui/PPopover.vue'
import PTooltip from '@/ui/PTooltip.vue'

async function flush() {
  for (let i = 0; i < 4; i++) {
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
  }
}

function mount(render: () => VNode) {
  const root = document.createElement('div')
  root.id = 'app'
  document.body.append(root)
  const app = createApp(defineComponent({ render }))
  app.mount(root)
  return () => {
    app.unmount()
    root.remove()
  }
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}

function byId(id: string) {
  return document.querySelector(`[id="${id}"]`)
}

function renderTooltip() {
  return h(PTooltip, { content: 'Fit to viewport' }, {
    default: () => h('button', { id: 'fit' }, 'fit'),
  })
}

let cleanup: (() => void) | null = null
afterEach(() => {
  cleanup?.()
  cleanup = null
  document.body.innerHTML = ''
})

describe('ppopover (click)', () => {
  it('wires aria on the trigger, opens on click, closes on escape and returns focus', async () => {
    const opened = ref(false)
    cleanup = mount(() => h(PPopover, {
      'modelValue': opened.value,
      'onUpdate:modelValue': (v: boolean) => {
        opened.value = v
      },
    }, {
      default: () => h('button', { id: 'trig' }, 'Sort'),
      content: () => h('div', [h('button', { id: 'inner' }, 'A')]),
    }))
    await flush()
    const trigger = document.querySelector<HTMLButtonElement>('#trig')!
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    trigger.focus()
    trigger.click()
    await flush()
    expect(opened.value).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const content = document.querySelector('[role="dialog"]')!
    expect(content).toBeTruthy()
    expect(trigger.getAttribute('aria-controls')).toBe(content.id)
    expect(content.getAttribute('aria-labelledby')).toBe('trig')
    expect(layerCount.value).toBe(1)

    press(document.activeElement ?? document.body, 'Escape')
    await flush()
    expect(opened.value).toBe(false)
    expect(layerCount.value).toBe(0)
    expect(document.activeElement).toBe(trigger)
  })
})

describe('pdialog', () => {
  it('is a labelled modal layer; escape cancels, enter on the container confirms', async () => {
    const events: string[] = []
    cleanup = mount(() => h(PDialog, {
      title: 'Delete?',
      confirmLabel: 'OK',
      cancelLabel: 'Cancel',
      onConfirm: () => events.push('confirm'),
      onCancel: () => events.push('cancel'),
    }, { default: () => 'Body text' }))
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')!
    expect(byId(labelledBy)?.textContent).toContain('Delete?')
    expect(byId(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('Body text')
    expect(layerCount.value).toBe(1)

    press(document.body, 'Escape')
    expect(events).toEqual(['cancel'])

    dialog.focus()
    press(dialog, 'Enter')
    expect(events).toEqual(['cancel', 'confirm'])
  })

  it('danger dialogs focus cancel first, and enter on a button is left to the button', async () => {
    const events: string[] = []
    cleanup = mount(() => h(PDialog, {
      title: 'Delete?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger',
      onConfirm: () => events.push('confirm'),
      onCancel: () => events.push('cancel'),
    }))
    await flush()
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(dialog).toBeTruthy()
    const focused = document.activeElement as HTMLElement
    expect(focused.textContent?.trim()).toBe('Cancel')
    press(focused, 'Enter')
    expect(events).toEqual([])
  })
})

describe('pmenu', () => {
  it('opens from shift+f10 on the focused element, groups labels, skips nothing and closes on tab', async () => {
    const picked: unknown[] = []
    cleanup = mount(() => h(PMenu, {
      data: [
        { role: 'label', title: 'Group' },
        { title: 'One', value: 1 },
        { title: 'Two', value: 2, disabled: true },
      ],
      ariaLabel: 'Actions',
      onSelect: (v: unknown) => picked.push(v),
    }, { default: () => h('button', { id: 'cell' }, 'cell') }))
    await flush()
    const cell = document.querySelector<HTMLButtonElement>('#cell')!
    cell.focus()
    press(cell, 'F10', { shiftKey: true })
    await flush()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu).toBeTruthy()
    expect(menu.getAttribute('aria-label')).toBe('Actions')
    const group = menu.querySelector('[role="group"]')!
    expect(byId(group.getAttribute('aria-labelledby')!)?.textContent?.trim()).toBe('Group')
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items).toHaveLength(2)
    expect(items[1].getAttribute('aria-disabled')).toBe('true')
    expect(items[1].hasAttribute('disabled')).toBe(false)

    // Disabled item: focusable but inert.
    items[1].click()
    expect(picked).toEqual([])

    press(items[0], 'Tab')
    await flush()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(cell)
  })
})

describe('ptooltip', () => {
  it('describes its trigger, shows on keyboard focus and hides on escape', async () => {
    cleanup = mount(renderTooltip)
    await flush()
    const trigger = document.querySelector<HTMLButtonElement>('#fit')!
    const describedBy = trigger.getAttribute('aria-describedby')!
    expect(byId(describedBy)?.textContent?.trim()).toBe('Fit to viewport')

    trigger.focus()
    trigger.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    await flush()
    expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe('Fit to viewport')
    expect(document.activeElement).toBe(trigger)

    press(trigger, 'Escape')
    await flush()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
