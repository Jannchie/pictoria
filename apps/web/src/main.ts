// Entry: kept tiny on purpose. A non-English session needs its message
// catalogue before the first paint (boot.ts mounts after `localeReady`), and
// that catalogue is a split chunk with a hashed name, so nothing in index.html
// can name it. Started here, its request goes out together with the app chunk
// below instead of after the whole app graph has downloaded and evaluated
// (where locale/index.ts would otherwise first ask for it).
import { preloadInitialLocale } from '@/locale/initial'

preloadInitialLocale()
void import('./boot')
