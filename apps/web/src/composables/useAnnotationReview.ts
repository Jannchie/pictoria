import type { Ref } from 'vue'
import type { ReviewKind } from '@/shared/annotationReview'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, onScopeDispose } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2EditAnnotation } from '@/api'
import { useAPIError } from '@/composables/useAPIError'
import { pushCommand } from '@/shared'
import { endReview, reviewing, setReviewHost } from '@/shared/annotationReview'
import { patchEntry } from '@/shared/annotationTimeline'

/**
 * Re-judging an already-submitted record, for whichever session is running.
 *
 * Both annotation sessions do the identical thing here — announce that they can host a
 * review, render the selected record, and on a verdict correct it in place, mirror it
 * into the history cache and push one undo command. Only two tokens differ: the event
 * kind and which field on the entry holds the verdict. Written out per session it was
 * ~37 lines twice, and the copies had already drifted (one restored `editedAt` on
 * revert, the other did not).
 *
 * `field` is what makes one body serve both: `winner` for pairwise, `value` for
 * absolute. It is the same column the backend's `_MUTABLE` table names.
 */
export function useAnnotationReview(options: {
  kind: ReviewKind
  field: 'winner' | 'value'
  /** i18n key for the undo-stack label. */
  labelKey: string
  /** The session's in-flight flag, so a correction and a judgement cannot overlap. */
  submitting: Ref<boolean>
}) {
  const { kind, field, labelKey, submitting } = options
  const { t } = useI18n()
  const { handle: handleAPIError } = useAPIError()
  const queryClient = useQueryClient()

  // Announced for as long as this session is alive. onScopeDispose rather than a
  // hand-written onUnmounted pair at each call site: the registration and its removal
  // are one fact, and separating them is how one of them goes missing.
  setReviewHost(kind)
  onScopeDispose(() => setReviewHost(null))

  /** The record under review, or null while judging normally. */
  const review = computed(() => (reviewing.value?.kind === kind ? reviewing.value : null))

  function write(id: number, verdict: string | number, editedAt: string | null) {
    return v2EditAnnotation({ path: { kind, annotation_id: id }, body: { verdict } })
      .then(() => patchEntry(queryClient, kind, id, { [field]: verdict, editedAt: editedAt ?? undefined }))
  }

  async function amend(verdict: string | number): Promise<void> {
    const entry = review.value
    if (!entry || submitting.value) {
      return
    }
    const previous = entry[field]
    if (previous === verdict) {
      endReview() // nothing to change; treat it as "yes, that one" and move on
      return
    }
    submitting.value = true
    try {
      await write(entry.id, verdict, new Date().toISOString())
      endReview()
      // Same undo stack as the judgements, so Ctrl+Z means one thing on this screen
      // rather than skipping past a correction to the judgement before it. Revert
      // restores the ORIGINAL editedAt too — dropping it would leave a row marked as
      // corrected after the correction was taken back.
      pushCommand({
        label: t(labelKey),
        postIds: [],
        apply: () => write(entry.id, verdict, new Date().toISOString()),
        revert: () => write(entry.id, previous as string | number, entry.editedAt ?? null),
      })
    }
    catch (error) {
      handleAPIError(error, t('annotate.history.editFailed'))
    }
    finally {
      submitting.value = false
    }
  }

  return { review, amend }
}
