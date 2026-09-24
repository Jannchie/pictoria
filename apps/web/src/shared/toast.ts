import { ref } from 'vue'

export interface ToastData {
  type: 'info' | 'success' | 'warning' | 'error'
  message: string
  /** Auto-dismiss after this many ms of *unpaused* display; omit to keep it until dismissed. */
  duration?: number
  closeable?: boolean
  color?: string
}

/** A queued toast: the pushed data plus a stable id (list key, dismissal handle). */
export interface Toast extends ToastData {
  readonly id: number
}

export const toasts = ref<Toast[]>([])

let nextId = 1

interface Countdown {
  remaining: number
  startedAt: number
  handle: ReturnType<typeof setTimeout> | null
}
const countdowns = new Map<number, Countdown>()
let paused = false

function run(id: number, c: Countdown) {
  c.startedAt = Date.now()
  c.handle = setTimeout(dismissToast, c.remaining, id)
}

/** Remove a toast by id (or by the toast itself). A no-op if it's already gone. */
export function dismissToast(toast: Toast | number) {
  const id = typeof toast === 'number' ? toast : toast.id
  const c = countdowns.get(id)
  if (c?.handle != null) {
    clearTimeout(c.handle)
  }
  countdowns.delete(id)
  const i = toasts.value.findIndex(t => t.id === id)
  if (i !== -1) {
    toasts.value.splice(i, 1)
  }
}

/**
 * Freeze every auto-dismiss countdown (WCAG 2.2.1): called while the pointer
 * is over a toast or keyboard focus is inside the toast region, so nothing
 * vanishes while it is being read or reached.
 */
export function pauseToasts() {
  if (paused) {
    return
  }
  paused = true
  const now = Date.now()
  for (const c of countdowns.values()) {
    if (c.handle != null) {
      clearTimeout(c.handle)
      c.handle = null
      c.remaining = Math.max(0, c.remaining - (now - c.startedAt))
    }
  }
}

/** Resume the countdowns frozen by `pauseToasts`, each with the time it had left. */
export function resumeToasts() {
  if (!paused) {
    return
  }
  paused = false
  for (const [id, c] of countdowns) {
    run(id, c)
  }
}

export function pushToast(toast: ToastData): Toast {
  const queued: Toast = { ...toast, id: nextId++ }
  toasts.value.push(queued)
  if (toast.duration) {
    const c: Countdown = { remaining: toast.duration, startedAt: Date.now(), handle: null }
    countdowns.set(queued.id, c)
    if (!paused) {
      run(queued.id, c)
    }
  }
  return queued
}

export function useToast() {
  return { pushToast }
}

/** Test-only: drop every toast, timer and the pause flag. */
export function _resetToasts() {
  for (const c of countdowns.values()) {
    if (c.handle != null) {
      clearTimeout(c.handle)
    }
  }
  countdowns.clear()
  toasts.value = []
  paused = false
}
