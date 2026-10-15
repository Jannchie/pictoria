// Compatibility re-export: the focus trap moved into the design system
// (`@/ui/useFocusTrap`). Kept only because CommandPalette.vue still imports this
// path and is frozen until the PostFilter refactor; delete it together with that
// import. Do not add new imports of this module.
export * from '../ui/useFocusTrap'
