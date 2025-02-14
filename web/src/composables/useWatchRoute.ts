import { postFilter } from '@/shared'
import { useRoute } from 'vue-router'

export function useWatchRoute() {
  const route = useRoute()
  watch(route, () => {
    switch (route.name) {
      case 'dir':
        if (Array.isArray(route.params.folder)) {
          if (route.params.folder.includes('@')) {
            postFilter.value.folder = '.'
          }
          else {
            postFilter.value.folder = route.params.folder.join('/')
          }
        }
        else {
          postFilter.value.folder = route.params.folder
        }
    }
  })
}
