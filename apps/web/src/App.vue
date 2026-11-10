<script setup lang="ts">
import type { ComponentPublicInstance, Ref } from 'vue'
import type { SplitpanesResizePayload } from '@/shared/paneLayout'
import { useResizeObserver } from '@vueuse/core'
import { Pane, Splitpanes } from 'splitpanes'
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watchEffect } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, START_LOCATION, useRoute, useRouter } from 'vue-router'
import { provideFolderTree } from '@/composables/useFolderTree'
import { useGlobalUndoRedo } from '@/composables/useGlobalUndoRedo'
import { usePaneSplitters } from '@/composables/usePaneSplitters'
import { usePostQuery } from '@/composables/usePostQuery'
import { useWatchRoute } from '@/composables/useWatchRoute'
import { isLeftCollapsed, isRightPaneShown, preferredSizesFromResize, setLeftCollapsed, setRightCollapsed, toggleLeftPane, toggleRightPane } from '@/shared/paneLayout'
import { shortcuts } from '@/shared/shortcuts'
import { hasModalLayer } from '@/ui/layers'
import { useHotkey } from '@/ui/useHotkey'
import { formatShortcut } from '@/utils/keyboard'
import { routeTitle, shouldAnnounceRoute, shouldFocusMain } from '@/utils/routeAnnounce'
import FolderTree from './components/FolderTree.vue'
import { announce, commandPaletteOpen, isAnyDialogOpen, shortcutHelpOpen, useSyncFilterWithUrl } from './shared'
import 'splitpanes/dist/splitpanes.css'

const { t } = useI18n()

useWatchRoute()
useGlobalUndoRedo()
// Lives here (not in FilterRow) so the filter↔URL watchers survive route
// changes — re-projecting the filters onto the URL after a navigation only
// works if the watcher is still alive when the path changes.
useSyncFilterWithUrl()
// The sidebar folder tree's state outlives the tree (the left pane unmounts
// when collapsed); FolderTree.vue injects it.
provideFolderTree()

const router = useRouter()
const route = useRoute()

// ── Global hotkeys ──────────────────────────────────────────────────────────
// ⌘K / Ctrl+K opens the palette from anywhere, including from inside an input
// (that's the point — it's the one key that always works).
useHotkey('Mod+K', () => {
  commandPaletteOpen.value = !commandPaletteOpen.value
}, { allowInTyping: true, allowInWidgets: true })

// '/' is the quick way in (the search-box convention), but it's a character:
// never while typing, and not over another dialog.
useHotkey('/', () => {
  commandPaletteOpen.value = true
}, { allowInWidgets: true, when: () => !isAnyDialogOpen.value })

// '?' opens the shortcut sheet, but only when not typing — otherwise it would
// swallow the character in the folder filter or a caption field.
useHotkey(shortcuts.global.openHelp.keys, () => {
  shortcutHelpOpen.value = true
}, { allowInWidgets: true, when: () => !isAnyDialogOpen.value })

// Pane toggles. Mod+B / Mod+Shift+B mirror the editor convention; the same
// state is driven by the bottom bar's buttons, which stay reachable once a
// pane is gone (the pane's own header would collapse with it).
// Toggling goes through paneLayout: below the auto-collapse widths it is a
// session override, not a change to the persisted preference.
useHotkey(shortcuts.global.toggleLeft.keys, toggleLeftPane, { allowInTyping: true, allowInWidgets: true, when: () => !isAnyDialogOpen.value })
useHotkey(shortcuts.global.toggleRight.keys, toggleRightPane, { allowInTyping: true, allowInWidgets: true, when: () => !isAnyDialogOpen.value })

// ── Layout: pane sizes, keyboard splitters, F6 landmark cycling ─────────────
const LEFT_PANE = { min: 8, max: 36 }
const RIGHT_PANE = { min: 12, max: 36 }
// Sizes (percent) live here so the keyboard splitters can set them; drags
// write them back through @resize / @resized. The centre takes the rest.
// What's stored is the user's *preferred* size; the rendered size is that
// preference clamped to the current pixel floor (`leftMin`/`rightMin`, below).
// Clamping on read instead of writing the floor back is what keeps a narrow
// window from ratcheting the panes: shrinking used to raise the stored size to
// the floor, and widening again kept it, so the side panes came back wider.
const leftPref = ref(12)
const rightPref = ref(12)

const split = useTemplateRef<ComponentPublicInstance>('split')
// Side panes also carry a pixel floor (min-w-64 = 256px). Below it the
// percent size is fiction: the pane stays 256px wide, so keyboard steps did
// nothing visible and aria-valuenow lied. Convert the floor to a percent of
// the layout width and use it as the effective minimum.
const SIDE_PANE_MIN_PX = 256
const splitWidth = ref(0)
useResizeObserver(() => split.value?.$el as HTMLElement | undefined, ([entry]) => {
  splitWidth.value = entry.contentRect.width
})
function floorPct(base: { min: number, max: number }) {
  if (splitWidth.value <= 0) {
    return base.min
  }
  return Math.min(base.max, Math.max(base.min, Math.ceil(SIDE_PANE_MIN_PX / splitWidth.value * 100)))
}
const leftMin = computed(() => floorPct(LEFT_PANE))
const rightMin = computed(() => floorPct(RIGHT_PANE))
function clampedSize(pref: Ref<number>, min: Ref<number>, max: number) {
  return computed({
    get: () => Math.min(max, Math.max(min.value, pref.value)),
    set: (v: number) => {
      pref.value = v
    },
  })
}
const leftSize = clampedSize(leftPref, leftMin, LEFT_PANE.max)
const rightSize = clampedSize(rightPref, rightMin, RIGHT_PANE.max)
const centerSize = computed(() =>
  100 - (isLeftCollapsed.value ? 0 : leftSize.value) - (isRightPaneShown.value ? rightSize.value : 0))
function onPanesResized(payload: SplitpanesResizePayload) {
  const sizes = preferredSizesFromResize(payload, { left: !isLeftCollapsed.value, right: isRightPaneShown.value })
  if (sizes.left !== undefined) {
    leftSize.value = sizes.left
  }
  if (sizes.right !== undefined) {
    rightSize.value = sizes.right
  }
}
const navEl = useTemplateRef<HTMLElement>('navEl')
const mainEl = useTemplateRef<HTMLElement>('mainEl')
const asideEl = useTemplateRef<HTMLElement>('asideEl')

// Enter on a splitter hides its pane. The splitter goes with it, so focus
// moves to the main area and the way back is announced.
function collapsePane(side: 'left' | 'right') {
  if (side === 'left') {
    setLeftCollapsed(true)
  }
  else {
    setRightCollapsed(true)
  }
  nextTick(() => mainEl.value?.focus({ preventScroll: true }))
  announce(side === 'left'
    ? t('pane.leftHidden', { key: formatShortcut(shortcuts.global.toggleLeft.keys[0]) })
    : t('pane.rightHidden', { key: formatShortcut(shortcuts.global.toggleRight.keys[0]) }))
}

usePaneSplitters(() => split.value?.$el as HTMLElement | undefined, [
  { id: 'pane-left', side: 'left', size: leftSize, min: leftMin, max: LEFT_PANE.max, label: () => t('pane.resizeLeft'), collapse: () => collapsePane('left') },
  { id: 'pane-right', side: 'right', size: rightSize, min: rightMin, max: RIGHT_PANE.max, label: () => t('pane.resizeRight'), collapse: () => collapsePane('right') },
])

// F6 / Shift+F6 cycle focus through the landmarks (sidebar nav → main →
// detail aside), skipping collapsed panes. The landmark element itself takes
// focus (its name is announced, Tab continues inside it); nav/aside get a
// temporary tabindex that is dropped on blur so mouse clicks never land on them.
function focusRegion(el: HTMLElement) {
  if (!el.hasAttribute('tabindex')) {
    el.setAttribute('tabindex', '-1')
    el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true })
  }
  el.focus({ preventScroll: true })
}
useHotkey(shortcuts.global.cycleRegions.keys, (e) => {
  const regions = [navEl.value, mainEl.value, asideEl.value].filter((el): el is HTMLElement => !!el?.isConnected)
  if (regions.length === 0) {
    return
  }
  const active = document.activeElement
  const current = regions.findIndex(el => el.contains(active))
  const dir = e.shiftKey ? -1 : 1
  const next = current === -1
    ? (dir === 1 ? 0 : regions.length - 1)
    : (current + dir + regions.length) % regions.length
  focusRegion(regions[next])
}, { allowInTyping: true, allowInWidgets: true, when: () => !hasModalLayer.value })

// ── Route changes: document.title, announcement, focus ──────────────────────
// The policy (which navigations announce / move focus) is in
// utils/routeAnnounce.ts, with tests.
const routePostId = computed(() => (route.name === 'post' ? Number(route.params.postId) : undefined))
const { data: routePost } = usePostQuery(routePostId)
const pageTitle = computed(() => {
  const post = routePost.value
  const postName = post && post.id === routePostId.value ? `${post.fileName}.${post.extension}` : null
  const title = routeTitle(route, postName)
  return title.key ? t(title.key, title.params ?? {}) : (title.text ?? '')
})
watchEffect(() => {
  document.title = t('route.documentTitle', { title: pageTitle.value })
})

const removeAfterEach = router.afterEach((to, from, failure) => {
  if (failure) {
    return
  }
  const initial = from === START_LOCATION
  const announceIt = shouldAnnounceRoute(to, from, initial)
  const focusIt = shouldFocusMain(to, from, initial)
  if (!announceIt && !focusIt) {
    return
  }
  // Route views are lazy chunks: give the new view a moment to mount (and to
  // place focus itself) before judging where focus is.
  setTimeout(() => {
    if (announceIt) {
      announce(t('route.navigated', { title: pageTitle.value }))
    }
    const main = mainEl.value
    const active = document.activeElement
    const focusInMain = !!main && !!active && active !== document.body && main.contains(active)
    // A folder picked in the tree keeps focus in the tree.
    const inTree = active instanceof HTMLElement && active.closest('[role="tree"]') !== null
    if (focusIt && main && !focusInMain && !inTree && !hasModalLayer.value) {
      main.focus({ preventScroll: true })
    }
  }, 50)
})
onBeforeUnmount(removeAfterEach)
</script>

<template>
  <a
    href="#main-content"
    class="text-on-primary px-3 py-2 rounded bg-primary sr-only focus:left-2 focus:top-2 focus:absolute focus:z-9999 focus:not-sr-only"
  >
    {{ $t('common.skipToMain') }}
  </a>
  <DropOverlay />
  <UndoSnackbar />
  <div
    class="text-fg bg-bg flex flex-col h-100vh w-100vw select-none overflow-hidden"
  >
    <TagSelectorWindow />
    <Splitpanes
      ref="split"
      class="max-h-[calc(100vh-24px)]"
      :keyboard-step="0"
      @resize="onPanesResized"
      @resized="onPanesResized"
    >
      <Pane
        v-if="!isLeftCollapsed"
        id="pane-left"
        :min-size="leftMin"
        :size="leftSize"
        :max-size="LEFT_PANE.max"
        class="border-r border-border-subtle min-w-64"
      >
        <nav
          ref="navEl"
          :aria-label="$t('nav.aria')"
          class="flex flex-col h-full focus-visible:[outline-offset:-2px]"
        >
          <!-- Wordmark sits on the nav rows' icon column (24px: pane px-2 + row
               px-4) at body size: it is a label for the pane, not a hero. -->
          <div class="text-base tracking-tight font-semibold px-6 pb-1.5 pt-3 flex shrink-0 gap-2 items-center">
            <img
              src="/Pictoria.svg"
              alt=""
              aria-hidden="true"
              width="16"
              height="16"
              class="h-4 w-4"
            >
            <span>Pictoria</span>
          </div>
          <div class="px-2 pb-2">
            <SpecialPathList />
          </div>
          <FolderTree />
          <div>
            <SyncStatus />
            <div class="p-2">
              <RouterLink
                to="/settings"
                class="rounded block"
              >
                <PListItem
                  class="px-4!"
                  icon="i-tabler-settings"
                  :active="$route.path === '/settings'"
                  :title="$t('common.settings')"
                />
              </RouterLink>
            </div>
          </div>
        </nav>
      </Pane>
      <Pane id="pane-main" :size="centerSize" class="relative">
        <main
          id="main-content"
          ref="mainEl"
          tabindex="-1"
          class="h-full focus-visible:[outline-offset:-2px]"
        >
          <RouterView />
        </main>
      </Pane>
      <Pane
        v-if="isRightPaneShown"
        id="pane-right"
        :min-size="rightMin"
        :size="rightSize"
        :max-size="RIGHT_PANE.max"
        class="border-l border-border-subtle min-w-64"
      >
        <aside
          ref="asideEl"
          :aria-label="$t('rightPanel.aria')"
          class="h-full focus-visible:[outline-offset:-2px]"
        >
          <RightPanel />
        </aside>
      </Pane>
    </Splitpanes>
    <BottomBar />
    <!-- Global toast outlet — useToast()/useAPIError() push here. -->
    <ToastSystem />
    <!-- ⌘K palette + its shortcut sheet; both are global singletons. -->
    <CommandPalette />
    <ShortcutHelp />
  </div>
</template>

<style>
.splitpanes__splitter:before {
  transition: opacity var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
.splitpanes__splitter:hover:before {
  opacity: 1;
  background-color: var(--p-border-strong);
}
.splitpanes--vertical > .splitpanes__splitter:before {left: -4px;right: -4px;height: 100%;}
.splitpanes--vertical .splitpanes__pane {
    transition: none;
    overflow: unset;
}
.splitpanes__splitter {
  width: 4px;
}
/* Keyboard-operable splitters (usePaneSplitters): splitpanes' own stylesheet
   sets outline:none on :focus, so restore a ring for keyboard focus. */
.splitpanes .splitpanes__splitter:focus-visible {
  outline: var(--p-focus-ring);
  outline-offset: -1px;
  background-color: var(--p-primary);
}
</style>
