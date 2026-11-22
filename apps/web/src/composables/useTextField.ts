import { ref, watch } from 'vue'

/**
 * A post's free-text field (caption / source) edited through a local draft
 * that commits on blur or an explicit key (Mod+Enter for the caption, Enter for
 * the single-line source) — one edit, one undo entry, instead of one every
 * 500 ms pause. On failure the draft rolls back to the server's value and the
 * field is marked invalid.
 */
export function useTextField(opts: {
  /** The post the field belongs to; a change resets the invalid mark. */
  postId: () => number
  /** The server's current value. */
  read: () => string
  /**
   * Whether the server value is real. The fields are disabled until the
   * detail is in; without it the old value would be a stand-in ''.
   */
  ready: () => boolean
  commit: (id: number, oldValue: string, newValue: string) => Promise<void>
  onError: (error: unknown) => void
}) {
  const draft = ref<string>(opts.read())
  const invalid = ref(false)
  let editing = false
  // The server value changed (another post / undo / edited elsewhere) while
  // not editing: the draft follows it.
  watch([opts.postId, opts.read], () => {
    if (!editing) {
      draft.value = opts.read()
    }
  })
  watch(opts.postId, () => {
    invalid.value = false
  })
  async function save() {
    editing = false
    if (!opts.ready()) {
      return
    }
    const id = opts.postId()
    const oldValue = opts.read()
    const newValue = draft.value ?? ''
    if (newValue === oldValue) {
      return
    }
    try {
      await opts.commit(id, oldValue, newValue)
      invalid.value = false
    }
    catch (error) {
      opts.onError(error)
      if (opts.postId() === id) {
        draft.value = oldValue
        invalid.value = true
      }
    }
  }
  return {
    draft,
    invalid,
    onFocus: () => {
      editing = true
    },
    save,
  }
}
