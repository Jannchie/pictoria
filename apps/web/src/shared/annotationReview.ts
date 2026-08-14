import type { TimelineEntryPublic } from '@/api'
import { computed, ref } from 'vue'

/**
 * The record currently being re-judged, shared between the history list and the
 * annotation session.
 *
 * These two live in different panes — the list is in the right pane, the session is
 * in the router view — so they have no props/emits path between them and the handoff
 * has to go through state. What crosses is deliberately just the entry: the session
 * decides how to render and amend it, the list only decides which one.
 *
 * `host` is the other direction. The list must not offer a row it has nowhere to
 * send: only a running session of the matching kind can host a review, so the session
 * publishes what it can take and the list disables the rest rather than accepting a
 * click that would visibly do nothing.
 */

export type ReviewKind = 'pairwise' | 'absolute'

const host = ref<ReviewKind | null>(null)
const entry = ref<TimelineEntryPublic | null>(null)

/** The record under review, or null while judging normally. */
export const reviewing = computed(() => entry.value)

/** Whether a running session could host a review of this entry. */
export function canReview(e: TimelineEntryPublic): boolean {
  return host.value !== null && e.kind === host.value
}

export function startReview(e: TimelineEntryPublic): void {
  if (canReview(e)) {
    entry.value = e
  }
}

export function endReview(): void {
  entry.value = null
}

/**
 * Called by a session for its whole lifetime. Clearing the host also ends any review
 * in flight: the screen that was displaying the record is gone, so leaving it set
 * would strand the state and re-open a stale review on the next session.
 */
export function setReviewHost(kind: ReviewKind | null): void {
  host.value = kind
  if (kind === null) {
    entry.value = null
  }
}
