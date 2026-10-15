// "Is a dialog open?" — pages gate their global hotkeys on this (see
// useKeyScope). Every modal (PDialog, CommandPalette, ShortcutHelp, …) is a
// `modal: true` layer on the layer stack (`@/ui/layers`), so this is just
// `hasModalLayer` under the name the call sites already use.

export { hasModalLayer as isAnyDialogOpen } from './layers'
