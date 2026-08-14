import { ref } from 'vue'

// Open state for the ⌘K palette. Lives outside the component so any surface
// (a hint in the filter row, a bottom-bar button, a hotkey) can raise it
// without prop-drilling a ref through the layout.
export const commandPaletteOpen = ref(false)
export const shortcutHelpOpen = ref(false)

export function openCommandPalette() {
  commandPaletteOpen.value = true
}
export function closeCommandPalette() {
  commandPaletteOpen.value = false
}
