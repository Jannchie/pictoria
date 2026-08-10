import { computed, ref } from 'vue'

// Count of mounted <PDialog> modals — PDialog.vue increments/decrements on
// mount/unmount. Pages gate their global onKeyStroke hotkeys on this
// (see canHandle*Keys): PDialog's own Enter/Escape handlers can't swallow
// other window-level listeners, so the standing-down has to happen at each
// listener's guard, and a shared count beats every caller hand-tracking its
// own "is my dialog open" flag.
export const openDialogCount = ref(0)
export const isAnyDialogOpen = computed(() => openDialogCount.value > 0)
