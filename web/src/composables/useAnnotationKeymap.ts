/** Keyboard layout for the annotation flow: dimension i uses keyboard row i. */
export const KEY_ROWS: readonly string[][] = [
  ['1', '2', '3', '4', '5'],
  ['q', 'w', 'e', 'r', 't'],
  ['a', 's', 'd', 'f', 'g'],
  ['z', 'x', 'c', 'v', 'b'],
]

export interface KeyChoice { dimension: string, value: number }

export function keyToChoice(key: string, dimensions: string[], scale: number): KeyChoice | null {
  for (let row = 0; row < dimensions.length && row < KEY_ROWS.length; row++) {
    const idx = KEY_ROWS[row].indexOf(key)
    if (idx >= 0 && idx < scale) {
      return { dimension: dimensions[row], value: idx + 1 }
    }
  }
  return null
}

/** All keys the absolute annotator listens to, for onKeyStroke registration. */
export function activeKeys(dimensions: string[], scale: number): string[] {
  return dimensions.flatMap((_, row) => KEY_ROWS[row]?.slice(0, scale) ?? [])
}
