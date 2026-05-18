<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { decodeArthashSvg } from '@/utils/arthash'

const props = withDefaults(
  defineProps<{
    hash: string | null | undefined
    revealed: boolean
    // fancy=true: 4-tier staggered shape-by-shape dissolve.
    // fancy=false: render the same arthash SVG but fade the whole wrapper
    //   as one layer. Same placeholder visual, one tenth of the GPU cost.
    fancy?: boolean
  }>(),
  { fancy: true },
)

const wrapper = ref<HTMLDivElement | null>(null)
const svg = ref<string>('')
const dissolving = ref(false)
// True once the dissolve animation has completed (or was skipped). The
// wrapper unmounts to free DOM nodes and GPU compositor layers.
const done = ref(false)
// True once the SVG is mounted AND (for fancy mode) regrouped into tiers,
// so the CSS animation has real elements to bind to. We must wait for this
// before starting the doneTimer — otherwise the timer races ahead of the
// animation start and unmounts the wrapper mid-fade.
const ready = ref(false)

const FANCY_TOTAL_MS = 360
const FANCY_PER_GROUP_MS = 140
// At 65 shapes/tile per-element animation got promoted to one compositor
// layer each (verified empirically — not-grouped felt noticeably worse than
// grouped at 50 tiles). Bucketing into 4 area-sorted tiers caps the layer
// cost at 4/tile while keeping a "biggest-first" cadence visible.
const TIERS = 4
const PLAIN_TOTAL_MS = 240
const SVG_NS = 'http://www.w3.org/2000/svg'

watch(
  () => props.hash,
  async (hash) => {
    if (props.revealed || !hash) {
      done.value = true
      return
    }
    const decoded = (await decodeArthashSvg(hash)) ?? ''
    // Race: image may have arrived during wasm decode. Skip rendering the
    // SVG entirely instead of mounting it just to immediately animate it out.
    if (props.revealed) {
      done.value = true
      return
    }
    svg.value = decoded
  },
  { immediate: true },
)

function measureArea(el: SVGElement): number {
  if (el.tagName.toLowerCase() === 'rect') {
    const w = Number.parseFloat(el.getAttribute('width') || '0')
    const h = Number.parseFloat(el.getAttribute('height') || '0')
    return w * h
  }
  // arthash's RECT codec emits exactly one non-rect element (a <path> covering
  // the full viewBox) as the background. Treat it as max area so it always
  // lands in tier 0.
  return Number.POSITIVE_INFINITY
}

/** Repack the SVG children into TIERS area-sorted <g> wrappers. We move the
 *  original shape nodes (no clones) so the SVG keeps its visual output, and
 *  the browser only has to animate TIERS groups instead of every shape. */
function groupShapes() {
  const wrap = wrapper.value
  if (!wrap) {
    return
  }
  const svgEl = wrap.querySelector('svg')
  if (!svgEl) {
    return
  }
  const shapes: { el: SVGElement, area: number }[] = []
  // Snapshot children before mutation — live HTMLCollections re-index as we
  // move nodes, which would skip elements during iteration.
  const topLevel = [...svgEl.children]
  for (const node of topLevel) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'defs' || tag === 'filter') {
      continue
    }
    // Already-grouped from a previous run — leave alone.
    if ((node as Element).classList.contains('a-tier')) {
      continue
    }
    // Blurred SVGs wrap shapes in <g filter="url(#b)">; unwrap one level
    // so we can re-group by area.
    if (tag === 'g') {
      const inners = [...(node as SVGGElement).children]
      for (const inner of inners) {
        shapes.push({ el: inner as SVGElement, area: measureArea(inner as SVGElement) })
      }
      node.remove()
    }
    else {
      shapes.push({ el: node as SVGElement, area: measureArea(node as SVGElement) })
    }
  }
  const n = shapes.length
  if (n === 0) {
    return
  }
  shapes.sort((a, b) => b.area - a.area)
  const tiers = Math.min(TIERS, n)
  const tierSize = Math.ceil(n / tiers)
  const span = Math.max(0, FANCY_TOTAL_MS - FANCY_PER_GROUP_MS)
  // Build the tier groups in a fragment first, then attach in one shot —
  // saves the (tiers + n) intermediate layout invalidations that piecewise
  // append() against the live SVG would trigger.
  const fragment = document.createDocumentFragment()
  for (let t = 0; t < tiers; t++) {
    const g = document.createElementNS(SVG_NS, 'g')
    g.classList.add('a-tier')
    const delay = tiers <= 1 ? 0 : (span * t) / (tiers - 1)
    g.style.setProperty('--d', `${delay.toFixed(1)}ms`)
    const start = t * tierSize
    const end = Math.min(n, start + tierSize)
    for (let i = start; i < end; i++) {
      // appendChild on a node already in the tree MOVES it — exactly what we want.
      g.append(shapes[i].el)
    }
    fragment.append(g)
  }
  svgEl.append(fragment)
}

watch(svg, async (value) => {
  if (!value) {
    return
  }
  await nextTick()
  // Plain mode fades the wrapper as a single layer — no DOM restructuring needed.
  if (props.fancy) {
    groupShapes()
  }
  ready.value = true
})

let doneTimer: ReturnType<typeof setTimeout> | null = null

function maybeStartDissolve() {
  if (!props.revealed || !ready.value || dissolving.value || done.value) {
    return
  }
  dissolving.value = true
  if (doneTimer) {
    clearTimeout(doneTimer)
  }
  const duration = props.fancy ? FANCY_TOTAL_MS : PLAIN_TOTAL_MS
  // Generous tail buffer (vs animation duration) to absorb any compositor
  // jitter on the final frame — cheaper than risking a visible pop on unmount.
  doneTimer = setTimeout(() => {
    done.value = true
  }, duration + 120)
}

watch(() => props.revealed, () => {
  void nextTick(maybeStartDissolve)
})
watch(ready, () => {
  void nextTick(maybeStartDissolve)
})
</script>

<template>
  <div
    v-if="!done"
    ref="wrapper"
    class="arthash-placeholder"
    :class="{ dissolving, fancy }"
    v-html="svg"
  />
</template>

<style scoped>
.arthash-placeholder {
  position: absolute;
  inset: 0;
  pointer-events: none;
  /* Isolate the placeholder so its layout/paint can't ripple out to siblings. */
  contain: layout paint;
  opacity: 1;
}
.arthash-placeholder :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
/* Round each rect's corners. The SVG viewBox is in image-thumbnail units
   (~32-64 per side), so even rx=1 visibly softens the mosaic without
   eating the silhouette. Background <path> is unaffected (rx is rect-only). */
.arthash-placeholder :deep(svg rect) {
  rx: 1;
  ry: 1;
}
/* Fancy mode — per-tier staggered opacity fade. 4 GPU layers per tile. */
.arthash-placeholder.fancy.dissolving :deep(.a-tier) {
  animation: arthash-fade 140ms ease-out forwards;
  animation-delay: var(--d, 0ms);
}
/* Pause dissolves while the user scrolls — the compositor is already busy
   laying out freshly-mounted tiles, animation work just steals frame budget.
   When `.scrolling` lifts (150 ms after last scroll event), animations
   resume from where they paused. */
html.scrolling .arthash-placeholder.fancy.dissolving :deep(.a-tier) {
  animation-play-state: paused;
}
/* Plain mode — fade the whole wrapper as a single layer. */
.arthash-placeholder:not(.fancy) {
  transition: opacity 240ms ease-out;
}
.arthash-placeholder:not(.fancy).dissolving {
  opacity: 0;
}
@keyframes arthash-fade {
  from { opacity: 1; }
  to   { opacity: 0; }
}
</style>
