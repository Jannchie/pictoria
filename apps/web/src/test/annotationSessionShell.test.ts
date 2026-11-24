// @vitest-environment happy-dom
import type { StreamLoadState } from '@/composables/useAnnotationStream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import AnnotationSessionShell from '@/components/annotate/AnnotationSessionShell.vue'
import { i18n } from '@/locale'

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    c()
  }
})

interface State {
  loadState: StreamLoadState
  active: boolean
  wrapHints?: boolean
}

function mountShell(initial: State, slots: Record<string, () => ReturnType<typeof h> | ReturnType<typeof h>[]> = {}) {
  const state = reactive<State>({ ...initial })
  const onExit = vi.fn()
  const onRetry = vi.fn()
  const host = document.createElement('div')
  document.body.append(host)
  const app = createApp({
    render: () => h(AnnotationSessionShell, {
      title: 'Session title',
      progress: '3 judged',
      hints: [{ keys: ['Esc'], label: 'Exit' }],
      kind: 'pairwise',
      done: 3,
      loadState: state.loadState,
      active: state.active,
      wrapHints: state.wrapHints,
      onExit,
      onRetry,
    }, {
      default: () => h('div', { 'data-test': 'body' }, 'judging surface'),
      ...slots,
    }),
  })
  app.use(i18n)
  app.mount(host)
  cleanups.push(() => {
    app.unmount()
    host.remove()
  })
  return { host, state, onExit, onRetry }
}

const body = (host: HTMLElement) => host.querySelector('[data-test=body]')
const legend = (host: HTMLElement) => host.querySelector('[role=note]')
function homeOf(host: HTMLElement) {
  return [...host.querySelectorAll('button')].find(b => b.textContent?.includes(i18n.global.t('annotate.finished.home')))!
}

describe('annotation session shell', () => {
  it('is a labelled, focusable region with the title and progress in the top bar', () => {
    const { host } = mountShell({ loadState: 'ready', active: true })
    const region = host.querySelector<HTMLElement>('[role=region]')!
    expect(region.getAttribute('aria-label')).toBe('Session title')
    expect(region.getAttribute('tabindex')).toBe('-1')
    expect(host.querySelector('h2')!.textContent?.trim()).toBe('Session title')
    expect(host.textContent).toContain('3 judged')
  })

  it('shows the judging surface and the key legend while active', () => {
    const { host } = mountShell({ loadState: 'ready', active: true })
    expect(body(host)).not.toBeNull()
    expect(legend(host)).not.toBeNull()
    expect(host.querySelector('[role=status]')).toBeNull()
  })

  it('shows the loading line when nothing is on screen yet', () => {
    const { host } = mountShell({ loadState: 'loading', active: false })
    expect(body(host)).toBeNull()
    const status = host.querySelector('[role=status]')!
    expect(status.textContent).toContain(i18n.global.t('common.loading'))
    // Not finished, so the legend stays.
    expect(legend(host)).not.toBeNull()
  })

  it('lets the session replace the loading line', () => {
    const { host } = mountShell({ loadState: 'ready', active: false }, {
      loading: () => h('div', { 'data-test': 'skeleton' }),
    })
    expect(host.querySelector('[data-test=skeleton]')).not.toBeNull()
    expect(host.querySelector('[role=status]')).toBeNull()
  })

  it('shows the load error with a retry that reaches the session', () => {
    const { host, onRetry } = mountShell({ loadState: 'error', active: false })
    const alert = host.querySelector('[role=alert]')!
    expect(alert).not.toBeNull()
    alert.querySelector('button')!.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows the finished screen and drops the legend once exhausted with nothing on screen', () => {
    const { host, onExit } = mountShell({ loadState: 'exhausted', active: false })
    expect(body(host)).toBeNull()
    expect(legend(host)).toBeNull()
    homeOf(host).click()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('keeps the surface while exhausted but something is still on it', () => {
    const { host } = mountShell({ loadState: 'exhausted', active: true })
    expect(body(host)).not.toBeNull()
    expect(legend(host)).not.toBeNull()
  })

  it('switches between states as the stream moves', async () => {
    const { host, state } = mountShell({ loadState: 'loading', active: false })
    expect(host.querySelector('[role=status]')).not.toBeNull()
    state.loadState = 'ready'
    state.active = true
    await nextTick()
    expect(body(host)).not.toBeNull()
    state.loadState = 'exhausted'
    state.active = false
    await nextTick()
    expect(body(host)).toBeNull()
    expect(legend(host)).toBeNull()
  })

  it('forwards finished actions only when given, keeping the home button primary otherwise', () => {
    const plain = mountShell({ loadState: 'exhausted', active: false })
    const withActions = mountShell({ loadState: 'exhausted', active: false }, {
      finished: () => h('button', { 'data-test': 'switch' }, 'switch'),
    })
    expect(homeOf(plain.host).classList.contains('p-btn--primary')).toBe(true)
    expect(homeOf(withActions.host).classList.contains('p-btn--subtle')).toBe(true)
    expect(withActions.host.querySelector('[data-test=switch]')).not.toBeNull()
  })

  it('the exit button emits exit', () => {
    const { host, onExit } = mountShell({ loadState: 'ready', active: true })
    host.querySelector<HTMLButtonElement>('button[aria-keyshortcuts=Escape]')!.click()
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('renders the extra slots in place', () => {
    const { host } = mountShell({ loadState: 'ready', active: true }, {
      'after-title': () => h('span', { 'data-test': 'flag' }),
      'after-progress': () => h('span', { 'data-test': 'agree' }),
      'header': () => h('div', { 'data-test': 'question' }),
    })
    expect((host.querySelector('h2')!.nextElementSibling as HTMLElement | null)?.dataset.test).toBe('flag')
    expect(host.querySelector('[data-test=agree]')).not.toBeNull()
    // The header strip sits directly above the body.
    expect(host.querySelector('[data-test=question]')!.nextElementSibling).toBe(body(host))
  })
})
