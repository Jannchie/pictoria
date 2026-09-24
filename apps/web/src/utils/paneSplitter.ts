// Keyboard model of the layout's pane splitters (WAI-ARIA APG "window
// splitter"). The value is the size of the splitter's *primary* pane — the side
// pane it belongs to — in percent of the split, so ←/→ mean "grow/shrink that
// pane" whichever side of the centre it sits on.
//
//   ←/→         resize by 1 %   (Shift: 10 %), toward the key's direction
//   Home / End  primary pane to its minimum / maximum size
//   Enter       collapse the pane (it is restored from the bottom bar / Ctrl+B)

export interface SplitterRange {
  value: number
  min: number
  max: number
}

export type SplitterAction
  = | { type: 'resize', value: number }
    | { type: 'collapse' }

export interface SplitterKey {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

export const SPLITTER_STEP = 1
export const SPLITTER_BIG_STEP = 10

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * `growKey` is the arrow that moves the splitter *into* the neighbouring
 * pane, i.e. grows the primary pane: `ArrowRight` for a left sidebar,
 * `ArrowLeft` for a right one.
 */
export function splitterKeyAction(e: SplitterKey, range: SplitterRange, growKey: 'ArrowRight' | 'ArrowLeft'): SplitterAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) {
    return null
  }
  const { value, min, max } = range
  const resize = (next: number): SplitterAction | null => {
    const v = Math.round(clamp(next, min, max) * 10) / 10
    return v === Math.round(value * 10) / 10 ? null : { type: 'resize', value: v }
  }
  const step = e.shiftKey ? SPLITTER_BIG_STEP : SPLITTER_STEP
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      return resize(value + (e.key === growKey ? step : -step))
    }
    case 'Home': {
      return e.shiftKey ? null : resize(min)
    }
    case 'End': {
      return e.shiftKey ? null : resize(max)
    }
    case 'Enter': {
      return e.shiftKey ? null : { type: 'collapse' }
    }
    default: {
      return null
    }
  }
}

/** Keys the splitter consumes even when they are a no-op at a bound. */
export function isSplitterKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End' || key === 'Enter'
}
