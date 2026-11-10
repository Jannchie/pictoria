import type { ComputedRef, Ref } from 'vue'
import { useStorage, useWindowSize } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { router } from '@/router'

/**
 * Which side panes are on screen.
 *
 * Three inputs, kept apart so none of them overwrites another:
 *
 * - the user's **persisted preference** (Mod+B / Mod+Shift+B, the footer
 *   buttons, the palette);
 * - an **automatic collapse** derived from the window width: below 1100px the
 *   detail pane goes, below 820px the folder sidebar too, so the gallery keeps
 *   a usable width (two 256px side panes left ~290px for it at 800px);
 * - a **session override**: toggling a pane while its auto-collapse is in
 *   force is respected for as long as the window stays that narrow, but it is
 *   not written to the preference. Crossing the threshold drops the override,
 *   so widening the window brings back exactly what the user had set.
 *
 * Routes with no use for the detail pane (Tags, Settings) say so with
 * `meta.rightPanel: false`: there it is not rendered and cannot be toggled.
 */

/** Pure resolution rule (tested): an override wins, else preference OR auto. */
export function resolveCollapsed(preference: boolean, auto: boolean, override: boolean | null): boolean {
  return override ?? (preference || auto)
}

const { width } = useWindowSize()

interface PaneState {
  collapsed: ComputedRef<boolean>
  set: (collapsed: boolean) => void
}

function pane(storageKey: string, autoBelowPx: number, available: () => boolean = () => true): PaneState {
  const preference: Ref<boolean> = useStorage(storageKey, false)
  // A 0 width (no layout yet, or a test environment) counts as wide.
  const auto = computed(() => width.value > 0 && width.value < autoBelowPx)
  const override = ref<boolean | null>(null)
  watch(auto, () => {
    override.value = null
  })
  return {
    collapsed: computed(() => resolveCollapsed(preference.value, auto.value, override.value)),
    set(collapsed) {
      if (!available()) {
        return
      }
      if (auto.value) {
        override.value = collapsed
      }
      else {
        preference.value = collapsed
      }
    },
  }
}

/** The current route wants a detail pane (`meta.rightPanel !== false`). */
export const routeHasRightPane = computed(() => router.currentRoute.value.meta.rightPanel !== false)

const left = pane('pictoria.pane.leftCollapsed', 820)
const right = pane('pictoria.pane.rightCollapsed', 1100, () => routeHasRightPane.value)

export const isLeftCollapsed = left.collapsed
export const isRightCollapsed = right.collapsed
/** The detail pane is rendered: the route wants one and it isn't collapsed. */
export const isRightPaneShown = computed(() => routeHasRightPane.value && !isRightCollapsed.value)

export const setLeftCollapsed = left.set
/** No-op on routes without a detail pane. */
export const setRightCollapsed = right.set
export const toggleLeftPane = () => left.set(!left.collapsed.value)
/** No-op on routes without a detail pane. */
export const toggleRightPane = () => right.set(!right.collapsed.value)

export interface SplitpanesResizePayload {
  /** Set when the user drives it (drag, keyboard, double-click); absent when splitpanes re-lays out after a pane is added / removed. */
  event?: Event
  panes?: { size: number }[]
}

/**
 * The user-preferred side-pane sizes to store after a splitpanes resize
 * (empty when there is nothing to store). Only user-driven resizes count:
 * splitpanes also emits `resized` (with no event) when a pane mounts or
 * unmounts — e.g. an auto-collapse on a narrow window — and its sizes then are
 * the narrow window's pixel floors, which must never become the preference
 * (widening again would bring the panes back far wider than before).
 */
export function preferredSizesFromResize(
  payload: SplitpanesResizePayload,
  layout: { left: boolean, right: boolean },
): { left?: number, right?: number } {
  const panes = payload.panes
  const out: { left?: number, right?: number } = {}
  if (!payload.event || !panes) {
    return out
  }
  let i = 0
  if (layout.left) {
    out.left = panes[i]?.size
    i++
  }
  i++ // the centre pane
  if (layout.right) {
    out.right = panes[i]?.size
  }
  return out
}
