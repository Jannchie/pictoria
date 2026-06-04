import { i18n } from '@/locale'
import { useToast } from '@/shared/toast'

/**
 * Centralised handler for API failures.
 *
 * The generated client (`@hey-api/openapi-ts`) throws on non-2xx and the
 * server now returns ``{detail, error}`` for domain errors (see
 * server/exceptions.py). Use this composable from `catch` blocks and
 * TanStack Query `onError` so the user gets a consistent toast instead of
 * a silent console.error.
 */

interface APIErrorBody {
  detail?: string
  error?: string
}

function isAPIErrorBody(value: unknown): value is APIErrorBody {
  return typeof value === 'object' && value !== null && ('detail' in value || 'error' in value)
}

/**
 * Extract a human-readable message from the messy union of error shapes we
 * may get: `Error` instances, hey-api `Response`-derived objects, plain
 * strings, or our backend's `{detail, error}` JSON.
 */
export function describeAPIError(err: unknown): string {
  // Resolved at error time so the message follows the current locale.
  const t = i18n.global.t
  if (err == null) {
    return t('error.unknown')
  }
  if (typeof err === 'string') {
    return err
  }
  if (err instanceof Error) {
    return err.message || err.name
  }
  if (isAPIErrorBody(err)) {
    return err.detail ?? err.error ?? t('error.requestFailed')
  }
  if (typeof err === 'object' && err !== null) {
    const maybeBody = (err as { body?: unknown }).body
    if (isAPIErrorBody(maybeBody)) {
      return maybeBody.detail ?? maybeBody.error ?? t('error.requestFailed')
    }
    const maybeMessage = (err as { message?: unknown }).message
    if (typeof maybeMessage === 'string') {
      return maybeMessage
    }
  }
  return t('error.requestFailed')
}

export function useAPIError() {
  const { pushToast } = useToast()

  function handle(err: unknown, prefix?: string) {
    const message = describeAPIError(err)
    const full = prefix ? `${prefix}: ${message}` : message
    pushToast({ type: 'error', message: full, duration: 4000, closeable: true })
    if (typeof console !== 'undefined') {
      console.error('[api]', full, err)
    }
  }

  return { handle, describeAPIError }
}
