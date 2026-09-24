import { describe, expect, it } from 'vitest'
import en from '@/locale/messages/en'
import { shortcutChords, shortcutGroups, shortcuts } from '@/shared/shortcuts'
import { parseShortcut } from '@/utils/keyboard'

function hasKey(path: string): boolean {
  let node: unknown = en
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object' || !(part in node)) {
      return false
    }
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string'
}

describe('shortcut catalogue', () => {
  it('every group title, description and gesture is a real i18n key', () => {
    const missing: string[] = []
    for (const group of shortcutGroups) {
      for (const key of [group.titleKey, ...group.entries.flatMap(e => [e.descKey, e.gestureKey ?? group.titleKey])]) {
        if (!hasKey(key)) {
          missing.push(key)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('every key parses in the shortcut grammar', () => {
    for (const group of shortcutGroups) {
      for (const entry of group.entries) {
        for (const key of entry.keys) {
          const shortcut = entry.gestureKey ? `${key}+x` : key
          expect(() => parseShortcut(shortcut), `${group.id}.${entry.id}: ${key}`).not.toThrow()
        }
      }
    }
  })

  it('range entries hold [from, to] pairs', () => {
    for (const group of shortcutGroups) {
      for (const entry of group.entries.filter(e => e.range)) {
        expect(entry.keys.length % 2, `${group.id}.${entry.id}`).toBe(0)
      }
    }
  })

  it('entry ids are unique within a group', () => {
    for (const group of shortcutGroups) {
      const ids = group.entries.map(e => e.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('shortcutchords', () => {
  const pc = { mac: false }
  const mac = { mac: true }

  it('collapses alternatives with the same modifiers into one chord', () => {
    expect(shortcutChords(shortcuts.viewer.pan, pc)).toEqual([
      { mods: ['Shift'], keys: ['←', '→', '↑', '↓'], range: false },
    ])
  })

  it('keeps alternatives with different modifiers apart', () => {
    expect(shortcutChords(shortcuts.global.redo, pc)).toEqual([
      { mods: ['Ctrl', 'Shift'], keys: ['Z'], range: false },
      { mods: ['Ctrl'], keys: ['Y'], range: false },
    ])
    expect(shortcutChords(shortcuts.global.redo, mac)).toEqual([
      { mods: ['⇧', '⌘'], keys: ['Z'], range: false },
      { mods: ['⌘'], keys: ['Y'], range: false },
    ])
  })

  it('marks ranges', () => {
    expect(shortcutChords(shortcuts.gallery.score, pc)).toEqual([{ mods: [], keys: ['1', '5'], range: true }])
  })

  it('gestures return only their modifier chord', () => {
    expect(shortcutChords(shortcuts.gallery.columns, pc)).toEqual([{ mods: ['Ctrl'], keys: [], range: false }])
    expect(shortcutChords(shortcuts.gallery.dragSelect, pc)).toEqual([])
  })

  it('names the menu key', () => {
    expect(shortcutChords(shortcuts.gallery.contextMenu, pc)).toEqual([
      { mods: ['Shift'], keys: ['F10'], range: false },
      { mods: [], keys: ['Menu'], range: false },
    ])
  })
})
