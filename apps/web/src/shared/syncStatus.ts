import type { QueuesStatus } from '@/api'

type SchedulerState = QueuesStatus['scheduler']['state']

/**
 * The one line the sidebar's sync-status header says about the *machinery*,
 * as opposed to the loops' progress. At most one applies; `null` = nothing to
 * report.
 *
 * `unreachable` outranks everything: the status poll itself failed, so every
 * number on screen is the last one that arrived — a frozen "Processing · 37%"
 * reads as progress that is not happening. TanStack keeps the old `data`
 * through a failed refetch, which is how that used to be shown indefinitely.
 *
 * For the scheduler, `starting` is the first second or two of every API boot —
 * not worth a line, let alone an alarm. `retrying` heals on its own, `failed`
 * needs a restart, `disabled` (PICTORIA_SCHEDULER=0) is deliberate.
 */
export type SyncNotice
  = | { kind: 'unreachable' }
    | { kind: 'scheduler', state: Exclude<SchedulerState, 'starting' | 'running'>, error: string | null }

export function syncNotice(status: QueuesStatus | undefined, pollFailed: boolean): SyncNotice | null {
  if (pollFailed) {
    return { kind: 'unreachable' }
  }
  if (!status) {
    return null
  }
  const { state, error } = status.scheduler
  switch (state) {
    case 'starting':
    case 'running': {
      return null
    }
    case 'failed':
    case 'retrying':
    case 'disabled': {
      return { kind: 'scheduler', state, error }
    }
    default: {
      const unknown: never = state
      return unknown
    }
  }
}

export interface SyncNoticeCopy {
  /** `danger` = something is broken and the user should know; `muted` = deliberate. */
  tone: 'danger' | 'muted'
  labelKey: string
  hintKey: string
}

export function syncNoticeCopy(notice: SyncNotice): SyncNoticeCopy {
  if (notice.kind === 'unreachable') {
    return { tone: 'danger', labelKey: 'syncStatus.unreachable', hintKey: 'syncStatus.unreachableHint' }
  }
  switch (notice.state) {
    case 'failed': {
      return { tone: 'danger', labelKey: 'syncStatus.schedulerDown', hintKey: 'syncStatus.schedulerDownHint' }
    }
    case 'retrying': {
      return { tone: 'danger', labelKey: 'syncStatus.schedulerRetrying', hintKey: 'syncStatus.schedulerRetryingHint' }
    }
    case 'disabled': {
      return { tone: 'muted', labelKey: 'syncStatus.schedulerDisabled', hintKey: 'syncStatus.schedulerDisabledHint' }
    }
  }
}
