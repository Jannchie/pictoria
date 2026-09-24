/**
 * Screen-reader announcements through two persistent, visually hidden live
 * regions appended to `<body>` on first use:
 * - polite:    `role="status"`, `aria-live="polite"`
 * - assertive: `role="alert"`,  `aria-live="assertive"`
 * Both are `aria-atomic="true"` and `data-layer-keep-active`, so a modal
 * layer's inert never silences them.
 *
 * Live regions only speak on *change*, and they must already exist in the DOM
 * before their text changes — hence persistent regions, and hence "clear,
 * then set the text 50 ms later", which also makes an identical message
 * (e.g. "3 selected" twice) speak again. A newer message on the same region
 * within that window replaces the pending one (last wins).
 *
 * Messages are user-visible text: pass them through i18n. No-op outside a
 * browser.
 */

export type Politeness = 'polite' | 'assertive'

const ANNOUNCE_DELAY_MS = 50

const regions: Partial<Record<Politeness, HTMLElement>> = {}
const pending: Partial<Record<Politeness, ReturnType<typeof setTimeout>>> = {}

// Standard "sr-only" clip: stays in the accessibility tree, occupies no space.
const VISUALLY_HIDDEN = [
  'position:absolute',
  'width:1px',
  'height:1px',
  'margin:-1px',
  'padding:0',
  'border:0',
  'overflow:hidden',
  'clip:rect(0 0 0 0)',
  'clip-path:inset(50%)',
  'white-space:nowrap',
].join(';')

function region(politeness: Politeness): HTMLElement {
  const existing = regions[politeness]
  if (existing?.isConnected) {
    return existing
  }
  const el = document.createElement('div')
  el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status')
  el.setAttribute('aria-live', politeness)
  el.setAttribute('aria-atomic', 'true')
  el.dataset.layerKeepActive = ''
  el.dataset.announcer = politeness
  el.setAttribute('style', VISUALLY_HIDDEN)
  document.body.append(el)
  regions[politeness] = el
  return el
}

/**
 * Speaks `message` via the polite (default) or assertive live region.
 * Use `'assertive'` only for errors / things that must interrupt.
 *
 * @example
 * announce(t('common.loading'))
 * announce(t('error.requestFailed'), 'assertive')
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  if (typeof document === 'undefined' || !document.body) {
    return
  }
  const el = region(politeness)
  el.textContent = ''
  const prev = pending[politeness]
  if (prev !== undefined) {
    clearTimeout(prev)
  }
  pending[politeness] = setTimeout(() => {
    pending[politeness] = undefined
    el.textContent = message
  }, ANNOUNCE_DELAY_MS)
}
