// The app itself, loaded by main.ts (see there for why it is a separate chunk).
import { VueQueryPlugin } from '@tanstack/vue-query'
import { createApp } from 'vue'
import App from '@/App.vue'
import { i18n, localeReady } from '@/locale'
import { baseURL } from '@/shared'
import { createQueryClient } from '@/shared/queryClient'
import { highlightDirective } from '@/utils'
import { prewarmArthash } from '@/utils/arthash'
import { client } from './api/client.gen'
import { router } from './router'
import '@unocss/reset/tailwind-compat.css'
import 'virtual:uno.css'
import '@/styles/tokens.css'
import '@/style.css'
import '@/utils/highlight.css'

client.setConfig({
  baseURL,
  throwOnError: true,
})

// Load the arthash wasm module ahead of first use so the gallery render
// isn't blocked by it — by the time any placeholder needs to decode, the
// module is ready and decode is essentially sync.
prewarmArthash()

// Toggle a `scrolling` class on <html> for the lifetime of any scroll event
// burst. Components (notably ArthashPlaceholder) listen for this to pause
// their dissolve animations while the user is scrolling — the compositor
// is already busy laying out / painting freshly-mounted tiles, so freezing
// non-essential animations buys back frame budget.
let scrollEndTimer: ReturnType<typeof setTimeout> | null = null
const SCROLL_END_MS = 150
window.addEventListener('scroll', () => {
  document.documentElement.classList.add('scrolling')
  if (scrollEndTimer) {
    clearTimeout(scrollEndTimer)
  }
  scrollEndTimer = setTimeout(() => {
    document.documentElement.classList.remove('scrolling')
  }, SCROLL_END_MS)
}, { capture: true, passive: true })

globalThis.addEventListener('dragstart', () => {
  document.documentElement.classList.add('is-dragging')
}, { capture: true, passive: true })
globalThis.addEventListener('dragend', () => {
  document.documentElement.classList.remove('is-dragging')
}, { capture: true, passive: true })
globalThis.addEventListener('drop', () => {
  document.documentElement.classList.remove('is-dragging')
}, { capture: true, passive: true })

// Apply persisted color scheme before mount so it survives full-page reloads
// outside of <PSchemeSwitch> (which only mounts on /settings).
const storedScheme = localStorage.getItem('pictoria-color-scheme') ?? 'dark'
const resolvedScheme = storedScheme === 'auto'
  ? (globalThis.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  : storedScheme
document.documentElement.dataset.scheme = resolvedScheme

const app = createApp(App)
app.directive('highlight', highlightDirective)
app.use(i18n)
app.use(VueQueryPlugin, { queryClient: createQueryClient() })
app.use(router)
// After the initial locale's catalogue: non-English messages are a lazy chunk.
void localeReady.then(() => app.mount('#app'))
