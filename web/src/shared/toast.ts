import { ref } from 'vue'

export interface ToastData {
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  duration?: number
  closeable?: boolean
  color?: string
}
export const toasts = ref<ToastData[]>([])

export function useToast() {
  function pushToast(toast: ToastData) {
    toasts.value.push(toast)
  }
  return { pushToast }
}
