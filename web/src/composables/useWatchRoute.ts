import { useRoute } from 'vue-router'
import { postFilter, randomSeed } from '@/shared'

export function useWatchRoute() {
  const route = useRoute()
  // Fresh shuffle seed on each *entry* to /random (path change only, not on
  // query/filter tweaks). Stable across the infinite query's pages so offset
  // pagination doesn't reshuffle mid-scroll.
  watch(() => route.path, (path, oldPath) => {
    if (path === '/random' && !oldPath?.startsWith('/post/')) {
      randomSeed.value = Math.floor(Math.random() * 2_147_483_646) + 1
    }
  }, { immediate: true })
  watch(route, () => {
    switch (route.name) {
      case 'dir': {
        if (Array.isArray(route.params.folder)) {
          postFilter.value.folder = route.params.folder.includes('@') ? '.' : route.params.folder.join('/')
        }
        else {
          postFilter.value.folder = route.params.folder
        }
        break
      }
      case 'all': {
        postFilter.value.folder = undefined
        break
      }
      default: {
        if (route.path === '/' || route.path === '/random' || route.path === '/recently') {
          postFilter.value.folder = undefined
        }
      }
    }
  }, { immediate: true })
}
