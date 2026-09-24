import { computed, ref } from 'vue'
import { hasModalLayer } from '@/shared/layers'

// Legacy manual count of open modals. PDialog.vue increments/decrements it on
// mount/unmount, and CommandPalette / ShortcutHelp still bump it by hand until
// they migrate onto the layer stack (`@/shared/layers`, `modal: true`).
export const openDialogCount = ref(0)

// "Is a dialog open?" — pages gate their global hotkeys on this (see
// useKeyScope). True for either source: the legacy counter above, or any
// `modal: true` layer on the layer stack. Once every modal registers a layer,
// the counter can go.
export const isAnyDialogOpen = computed(() => openDialogCount.value > 0 || hasModalLayer.value)
