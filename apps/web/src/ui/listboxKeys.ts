/**
 * Space / Enter on a focused option toggles it (APG multi-select listbox).
 * Returns true when the key was consumed. IME composition, modifier chords
 * and auto-repeat are ignored so a held key doesn't flicker the selection.
 */
export function activateOptionOnKey(e: KeyboardEvent, activate: () => void): boolean {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) {
    return false
  }
  if (e.key !== 'Enter' && e.key !== ' ') {
    return false
  }
  e.preventDefault()
  if (!e.repeat) {
    activate()
  }
  return true
}
