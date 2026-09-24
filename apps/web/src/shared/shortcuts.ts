import type { ShortcutPlatformOptions } from '@/utils/keyboard'
import { shortcutKeys } from '@/utils/keyboard'

/**
 * The app's keyboard shortcut catalogue — one list for the help sheet
 * (`components/ShortcutHelp.vue`), the command palette's hints, and (where the
 * binding is a plain `useHotkey` / `handleHotkey` call) the binding sites
 * themselves, so a key and its documentation cannot drift apart.
 *
 * `keys` uses the foundation shortcut grammar (`'Mod+Shift+B'`, see
 * `@/utils/keyboard`); each item is an ALTERNATIVE binding. `descKey` is a
 * literal i18n key (the locale guard test checks it exists).
 *
 * Widget-local keys (tree, listboxes, splitters, the sortable ranking cards)
 * are implemented by their components; they are listed here for the help
 * sheet only. When you change one of those, update the entry by hand.
 */
export interface ShortcutDef {
  /** Alternative bindings, foundation shortcut syntax. */
  readonly keys: readonly string[]
  /** Literal i18n key describing the action. */
  readonly descKey: string
  /** Display `keys` as consecutive `[from, to]` ranges (`1–5`). */
  readonly range?: boolean
  /** Pointer gesture instead of a key: an i18n key for the gesture name (Wheel, Drag). `keys` then holds only its modifiers (may be empty). */
  readonly gestureKey?: string
}

export interface ShortcutEntry extends ShortcutDef {
  readonly id: string
}

export interface ShortcutGroup {
  readonly id: string
  readonly titleKey: string
  readonly entries: readonly ShortcutEntry[]
}

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const
const withMods = (mod: string, keys: readonly string[]) => keys.map(k => `${mod}+${k}`)

export const shortcuts = {
  global: {
    openPalette: { keys: ['Mod+K'], descKey: 'shortcuts.openPalette' },
    openHelp: { keys: ['?'], descKey: 'shortcuts.openHelp' },
    toggleLeft: { keys: ['Mod+B'], descKey: 'pane.toggleLeft' },
    toggleRight: { keys: ['Mod+Shift+B'], descKey: 'pane.toggleRight' },
    cycleRegions: { keys: ['F6', 'Shift+F6'], descKey: 'pane.cycleRegions' },
    undo: { keys: ['Mod+Z'], descKey: 'common.undo' },
    redo: { keys: ['Mod+Shift+Z', 'Mod+Y'], descKey: 'common.redo' },
    closeLayer: { keys: ['Escape'], descKey: 'shortcuts.closeLayer' },
    splitterResize: { keys: ['ArrowLeft', 'ArrowRight'], descKey: 'shortcuts.splitterResize' },
    splitterCollapse: { keys: ['Enter'], descKey: 'shortcuts.splitterCollapse' },
  },
  gallery: {
    move: { keys: [...ARROWS], descKey: 'gallery.keys.move' },
    extend: { keys: withMods('Shift', [...ARROWS, 'Home', 'End', 'PageUp', 'PageDown']), descKey: 'gallery.keys.extend' },
    moveCursor: { keys: withMods('Mod', ARROWS), descKey: 'gallery.keys.moveCursor' },
    toggle: { keys: ['Space', 'Mod+Space'], descKey: 'gallery.keys.toggle' },
    rangeToCursor: { keys: ['Shift+Space'], descKey: 'gallery.keys.rangeToCursor' },
    firstLast: { keys: ['Home', 'End'], descKey: 'gallery.keys.firstLast' },
    page: { keys: ['PageUp', 'PageDown'], descKey: 'gallery.keys.page' },
    selectAll: { keys: ['Mod+A'], descKey: 'gallery.keys.selectAll' },
    clearSelection: { keys: ['Escape'], descKey: 'gallery.keys.clearSelection' },
    openPost: { keys: ['Enter'], descKey: 'shortcuts.openPost' },
    deleteSelected: { keys: ['Delete', 'Mod+Backspace'], descKey: 'shortcuts.deleteSelected' },
    contextMenu: { keys: ['Shift+F10', 'ContextMenu'], descKey: 'gallery.keys.contextMenu' },
    score: { keys: ['1', '5'], range: true, descKey: 'shortcuts.scoreSelected' },
    columns: { keys: ['Ctrl'], gestureKey: 'shortcuts.wheel', descKey: 'shortcuts.columns' },
    dragSelect: { keys: [], gestureKey: 'shortcuts.drag', descKey: 'shortcuts.dragSelect' },
  },
  postPage: {
    prevNext: { keys: ['ArrowLeft', 'ArrowRight'], descKey: 'shortcuts.prevNext' },
    openViewer: { keys: ['Enter', 'Space'], descKey: 'shortcuts.fullscreen' },
    back: { keys: ['Escape'], descKey: 'post.keys.back' },
    deleteSelected: { keys: ['Delete'], descKey: 'shortcuts.deleteSelected' },
    score: { keys: ['1', '5'], range: true, descKey: 'shortcuts.scorePost' },
  },
  viewer: {
    close: { keys: ['Escape'], descKey: 'post.closeViewer' },
    prevNext: { keys: ['ArrowLeft', 'ArrowRight'], descKey: 'shortcuts.prevNext' },
    pan: { keys: withMods('Shift', ARROWS), descKey: 'post.keys.pan' },
    zoomIn: { keys: ['+', '='], descKey: 'post.keys.zoomIn' },
    zoomOut: { keys: ['-'], descKey: 'post.keys.zoomOut' },
    fit: { keys: ['0'], descKey: 'post.fitToViewport' },
    actualSize: { keys: ['\\'], descKey: 'post.actualSize' },
    flip: { keys: ['F'], descKey: 'post.flipHorizontal' },
  },
  folderTree: {
    move: { keys: ['ArrowUp', 'ArrowDown'], descKey: 'shortcuts.treeMove' },
    expand: { keys: ['ArrowRight'], descKey: 'sidebar.expand' },
    collapse: { keys: ['ArrowLeft'], descKey: 'sidebar.collapse' },
    expandSiblings: { keys: ['*'], descKey: 'shortcuts.treeExpandSiblings' },
    firstLast: { keys: ['Home', 'End'], descKey: 'shortcuts.firstLast' },
    typeahead: { keys: ['A', 'Z'], range: true, descKey: 'shortcuts.typeahead' },
    open: { keys: ['Enter'], descKey: 'sidebar.openFolder' },
    contextMenu: { keys: ['Shift+F10', 'ContextMenu'], descKey: 'gallery.keys.contextMenu' },
    deleteFolder: { keys: ['Delete'], descKey: 'sidebar.deleteFolder' },
  },
  palette: {
    move: { keys: ['ArrowUp', 'ArrowDown'], descKey: 'shortcuts.listMove' },
    page: { keys: ['PageUp', 'PageDown'], descKey: 'shortcuts.listPage' },
    firstLast: { keys: ['Mod+Home', 'Mod+End'], descKey: 'shortcuts.firstLast' },
    run: { keys: ['Enter'], descKey: 'shortcuts.paletteRun' },
    complete: { keys: ['Tab'], descKey: 'shortcuts.paletteComplete' },
    applyNow: { keys: ['Mod+Enter'], descKey: 'shortcuts.paletteApplyNow' },
    tagToggle: { keys: ['Enter'], descKey: 'shortcuts.tagToggle' },
    tagSwitchGroup: { keys: ['Mod+ArrowDown', 'Mod+ArrowUp'], descKey: 'shortcuts.tagSwitchGroup' },
  },
  annotation: {
    rate: { keys: ['1', '5', 'Q', 'T', 'A', 'G', 'Z', 'B'], range: true, descKey: 'shortcuts.annRate' },
    flag: { keys: ['0'], descKey: 'shortcuts.annFlag' },
    skip: { keys: ['Space'], descKey: 'shortcuts.annSkip' },
    undo: { keys: ['Mod+Z'], descKey: 'common.undo' },
    exit: { keys: ['Escape'], descKey: 'shortcuts.annExit' },
    pick: { keys: ['ArrowLeft', 'ArrowRight'], descKey: 'shortcuts.annPick' },
    tie: { keys: ['ArrowDown'], descKey: 'shortcuts.annTie' },
    submit: { keys: ['Enter', 'Mod+Enter'], descKey: 'shortcuts.annSubmit' },
    grab: { keys: ['Space', 'Enter'], descKey: 'shortcuts.annGrab' },
    moveCard: { keys: ['Alt+ArrowUp', 'Alt+ArrowDown'], descKey: 'shortcuts.annMove' },
    enlarge: { keys: ['V'], descKey: 'shortcuts.annEnlarge' },
  },
} as const satisfies Record<string, Record<string, ShortcutDef>>

export type ShortcutGroupId = keyof typeof shortcuts

const GROUP_TITLES: Record<ShortcutGroupId, string> = {
  global: 'shortcuts.global',
  gallery: 'shortcuts.grid',
  postPage: 'shortcuts.postPage',
  viewer: 'shortcuts.viewer',
  folderTree: 'shortcuts.folderTree',
  palette: 'shortcuts.palette',
  annotation: 'shortcuts.annotation',
}

/** The catalogue as ordered groups × entries, for rendering. */
export const shortcutGroups: readonly ShortcutGroup[] = (Object.keys(shortcuts) as ShortcutGroupId[]).map(id => ({
  id,
  titleKey: GROUP_TITLES[id],
  entries: Object.entries(shortcuts[id]).map(([entryId, def]) => ({ id: entryId, ...(def as ShortcutDef) })),
}))

/** One `<kbd>` row: modifier caps, then key caps (`'–'` between range ends is a separator, not a key). */
export interface ShortcutChord {
  readonly mods: readonly string[]
  readonly keys: readonly string[]
  readonly range: boolean
}

/**
 * Display form of an entry's key alternatives. Alternatives that share the
 * same modifiers collapse into one chord (`Shift` + `← → ↑ ↓`), so a list of
 * 8 bindings stays one short row. Gesture entries return the modifier chord
 * only; the caller appends the translated gesture name.
 */
export function shortcutChords(def: Pick<ShortcutDef, 'keys' | 'range' | 'gestureKey'>, options: ShortcutPlatformOptions = {}): ShortcutChord[] {
  if (def.gestureKey) {
    return def.keys.length === 0 ? [] : [{ mods: def.keys.flatMap(k => shortcutKeys(`${k}+x`, options).slice(0, -1)), keys: [], range: false }]
  }
  const chords: { mods: string[], keys: string[], range: boolean }[] = []
  for (const shortcut of def.keys) {
    const caps = shortcutKeys(shortcut, options)
    const mods = caps.slice(0, -1)
    const key = caps.at(-1) as string
    const last = chords.at(-1)
    if (last && last.mods.join('\u0000') === mods.join('\u0000')) {
      last.keys.push(key)
    }
    else {
      chords.push({ mods, keys: [key], range: Boolean(def.range) })
    }
  }
  return chords
}
