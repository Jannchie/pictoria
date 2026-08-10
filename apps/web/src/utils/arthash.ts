import { codec, init, toSvg } from 'arthash'

// Must match the server-side codec in server/src/utils.py
// (Codec.rect(n=32) → ~180-byte axis-aligned rectangle mosaic, 33 elements).
const arthashCodec = codec.rect({ n: 32 })

let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  initPromise ??= init()
  return initPromise
}

/**
 * Kick off the wasm module load eagerly so the first gallery render isn't
 *  blocked by it. Idempotent and silent on failure (decode will retry).
 */
export function prewarmArthash(): void {
  void ensureInit().catch(() => {})
}

// SVG output is deterministic from the hash; cache so we don't re-render
// the same mosaic every time a thumbnail re-mounts in a scroll list.
const svgCache = new Map<string, string>()

export async function decodeArthashSvg(b64: string): Promise<string | null> {
  const cached = svgCache.get(b64)
  if (cached) {
    return cached
  }
  try {
    await ensureInit()
    const bytes = Uint8Array.from(atob(b64), char => char.codePointAt(0) ?? 0)
    const svg = await toSvg(bytes, arthashCodec, { baseSize: 64 })
    svgCache.set(b64, svg)
    return svg
  }
  catch (error) {
    console.warn('Failed to decode arthash:', error)
    return null
  }
}
