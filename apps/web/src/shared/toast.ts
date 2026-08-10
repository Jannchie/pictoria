import { ref } from 'vue'

export interface ToastData {
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  duration?: number
  closeable?: boolean
  color?: string
}
export const toasts = ref<ToastData[]>([])

export function dismissToast(toast: ToastData) {
  const i = toasts.value.indexOf(toast)
  if (i !== -1) {
    toasts.value.splice(i, 1)
  }
}

function pushToast(toast: ToastData) {
  toasts.value.push(toast)
  if (toast.duration) {
    // Identity-based removal: a manual dismiss before the timer fires makes
    // this a no-op instead of removing a neighbour.
    setTimeout(dismissToast, toast.duration, toast)
  }
}
export function useToast() {
  return { pushToast }
}
