// The slice of culori the app uses, from the tree-shakable `culori/fn` entry.
// The default `culori` entry registers every colour space it knows (~30
// modes, all bundled); the app only parses CSS colours from the sort-colour
// picker / URL and converts between sRGB and CIELAB. Register those modes
// once here and import culori through this module only.
// src/test/culori.test.ts pins the output against the full build.
import { modeHsl, modeLab, modeRgb, useMode } from 'culori/fn'

useMode(modeRgb)
useMode(modeHsl)
useMode(modeLab)

export { converter, formatRgb, parse } from 'culori/fn'
