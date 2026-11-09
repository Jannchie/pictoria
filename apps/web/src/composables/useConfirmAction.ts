import type { ComputedRef } from 'vue'
import { computed, shallowRef } from 'vue'

/**
 * A confirm-then-run action (e.g. "Delete 3 images?") as one explicit state:
 *
 *   closed ──request(t)──▶ confirming(t) ──confirm()──▶ running(t)
 *     ▲  ▲                     │    ▲                      │  │
 *     │  └───── cancel() ──────┘    └───── run threw ──────┘  │
 *     └───────────────────── run resolved ────────────────────┘
 *
 * - `request` only opens from `closed`: a second request while the dialog is
 *   up or the action is in flight is ignored, so it can never swap the target
 *   under a running action.
 * - `cancel` is a no-op while `running` — the dialog (pass `isRunning` to
 *   PDialog's `busy`) stays up until the request settles.
 * - A failed run returns to `confirming` with the same target, so the user
 *   can retry or cancel; `onError` surfaces the failure.
 */
export type ConfirmPhase<T>
  = | { kind: 'closed' }
    | { kind: 'confirming', target: T }
    | { kind: 'running', target: T }

export interface ConfirmRunOptions<T> {
  /** The action itself. Its success side effects belong here. */
  run: (target: T) => Promise<void>
  /** Called when `run` throws; the phase is already back to `confirming`. */
  onError: (error: unknown, target: T) => void
}

export interface ConfirmAction<T> {
  /** The target while confirming or running (the dialog is shown), else null. */
  target: ComputedRef<T | null>
  isRunning: ComputedRef<boolean>
  /** Open the confirmation for `target`. Does nothing unless closed. */
  request: (target: T) => void
  /** Close the confirmation. Does nothing while running. */
  cancel: () => void
  /**
   * Run the confirmed action. Returns true once it succeeded (phase closed),
   * false when it was not confirming or the run failed (phase confirming).
   */
  confirm: (options: ConfirmRunOptions<T>) => Promise<boolean>
}

const CLOSED = { kind: 'closed' } as const

export function useConfirmAction<T>(): ConfirmAction<T> {
  const phase = shallowRef<ConfirmPhase<T>>(CLOSED)

  const target = computed(() => phase.value.kind === 'closed' ? null : phase.value.target)
  const isRunning = computed(() => phase.value.kind === 'running')

  function request(next: T) {
    if (phase.value.kind === 'closed') {
      phase.value = { kind: 'confirming', target: next }
    }
  }

  function cancel() {
    if (phase.value.kind !== 'running') {
      phase.value = CLOSED
    }
  }

  async function confirm({ run, onError }: ConfirmRunOptions<T>): Promise<boolean> {
    const current = phase.value
    if (current.kind !== 'confirming') {
      return false
    }
    phase.value = { kind: 'running', target: current.target }
    try {
      await run(current.target)
    }
    catch (error) {
      phase.value = current
      onError(error, current.target)
      return false
    }
    phase.value = CLOSED
    return true
  }

  return { target, isRunning, request, cancel, confirm }
}
