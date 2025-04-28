import { ref } from 'vue'

export interface ToastData {
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  duration?: number
  closeable?: boolean
  color?: string
}
export const toasts = ref<ToastData[]>([])

function pushToast(toast: ToastData) {
  toasts.value.push(toast)
}
export function useToast() {
  return { pushToast }
}
