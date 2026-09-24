<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import type { PMenuItem } from '@/ui'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Waterfall } from 'vue-wf'
import { v2SearchPostsByText } from '@/api'
import { useGalleryGrid } from '@/composables/useGalleryGrid'
import { useHotkey } from '@/composables/useHotkey'
import { useKeyScope, useScoreHotkeys } from '@/composables/useKeyScope'
import { announce, clear as clearSelection, commitRotate, commitScore, currentPostList, deletePosts, galleryScrollPositions, gridCursorId, lastViewedPostId, postFilter, queryKeys, selectedCount, selectedIdList, selectOnly, setGridCursor, textSearchQuery, useInfinityPostsQuery, waterfallRowCount } from '@/shared'
import { GRID_GAP, GRID_PAD } from '@/shared/gridLayout'
import { useToast } from '@/shared/toast'
import { POverlay } from '@/ui'
import PDialog from '@/ui/PDialog.vue'
import { isImageExtension } from '@/utils'
import { nextCursorAfterRemoval } from '@/utils/gridSelection'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const infinityPostsQuery = useInfinityPostsQuery()
const debouncedTextSearch = refDebounced(textSearchQuery, 400)
const textSearchPrompt = computed(() => debouncedTextSearch.value.trim())
const isTextSearchActive = computed(() => textSearchPrompt.value.length > 0)
const textSearchQueryResult = useQuery({
  queryKey: computed(() => queryKeys.textSearch(textSearchPrompt.value, postFilter.value)),
  queryFn: async () => {
    if (!textSearchPrompt.value) {
      return []
    }
    const resp = await v2SearchPostsByText({
      // Combine the prompt with the gallery's active filters so text search
      // respects rating / score / tags / extension / folder / waifu just like
      // the regular list. lab isn't included (backend ignores it for text).
      body: { query: textSearchPrompt.value, ...postFilter.value },
      query: { limit: 200 },
    })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  enabled: computed(() => isTextSearchActive.value),
  staleTime: 1000 * 30,
})
const textSearchResults = computed<Array<PostSimplePublic>>(() => textSearchQueryResult.data.value ?? [])
const folderPosts = computed<Array<PostSimplePublic>>(() => {
  return infinityPostsQuery.data.value?.pages.flat().filter(post => post !== undefined) ?? []
})
const posts = computed<Array<PostSimplePublic>>(() => {
  return isTextSearchActive.value ? textSearchResults.value : folderPosts.value
})
// Memoize item dimensions per post id so a re-render that doesn't change a
// post's size returns the same object reference. Waterfall layout treats
// items as a structural input; reusing references lets it short-circuit
// internal `===` checks instead of re-laying out the full grid.
const itemCache = new Map<number, { width: number, height: number }>()
const items = shallowRef<Array<{ width: number, height: number }>>([])
watchEffect(() => {
  const ps = posts.value
  const next = Array.from({ length: ps.length }) as Array<{ width: number, height: number }>
  const seen = new Set<number>()
  for (const [i, post] of ps.entries()) {
    const id = post.id as number
    const w = (isImageExtension(post.extension) && post.width) ? post.width : 1
    const h = (isImageExtension(post.extension) && post.height) ? post.height : 1
    const cached = itemCache.get(id)
    if (cached && cached.width === w && cached.height === h) {
      next[i] = cached
    }
    else {
      const item = { width: w, height: h }
      itemCache.set(id, item)
      next[i] = item
    }
    seen.add(id)
  }
  if (itemCache.size > seen.size * 4) {
    for (const key of itemCache.keys()) {
      if (!seen.has(key)) {
        itemCache.delete(key)
      }
    }
  }
  items.value = next
})

const waterfallRef = ref<InstanceType<typeof Waterfall> | null>(null)
const waterfallWrapperDom = computed(() => waterfallRef.value?.wrapper)
const waterfallWrapperBounds = useElementBounding(waterfallWrapperDom)
// Column width from the wrapper: N columns share the width minus the outer
// padding and the N-1 gaps. `cols` re-derives the count from that width so the
// skeleton and the Waterfall agree even while the wrapper is still 0 wide.
const waterfallItemWidth = computed(() => {
  return Math.floor((waterfallWrapperBounds.width.value - GRID_PAD * 2 - GRID_GAP * (waterfallRowCount.value - 1)) / waterfallRowCount.value)
})
const cols = computed(() => Math.floor((waterfallWrapperBounds.width.value - GRID_PAD * 2 + GRID_GAP) / (waterfallItemWidth.value + GRID_GAP)))
const layoutData = computed(() => {
  return waterfallRef.value?.layoutData
})
// Drag-box selection shared with the similar-posts grid (Post.vue) via the
// same composable, so both waterfalls select identically.
const { onSelectChange, onSelectEnd } = useWaterfallSelection(waterfallRef, posts)

function emptyPointerDown(e: PointerEvent) {
  // 如果是右键，且没有按 ctrl 或者 shift
  if (!e.ctrlKey && !e.shiftKey) {
    clearSelection()
    // 保留现有的查询参数，只清除 post_id
    const currentQuery = { ...route.query }
    delete currentQuery.post_id
    router.replace({ query: currentQuery })
  }
}

// Keep the shared list in sync so PostDetail / Post.vue can navigate prev/next
watchEffect(() => {
  currentPostList.value = posts.value
})

const mainSectionRef = ref<HTMLElement>()
// PScrollArea exposes its inner scroller as `$el`; both the scroll-position
// cache below and the infinite-scroll observer need it as their root.
const galleryScrollEl = computed<HTMLElement | undefined>(() => (mainSectionRef.value as unknown as { $el?: HTMLElement } | undefined)?.$el)

// Grid hotkeys stand down while a confirm dialog is open (Enter would
// otherwise open the post detail instead of confirming the delete), while a
// folder-tree row has focus (Delete targets that folder, not the selection),
// and while the fullscreen overlay is up — all folded into the shared scope.
const activeKeyScope = useKeyScope()
const inGridScope = () => activeKeyScope.value === 'grid'

// Drop a stale ?post_id from the URL once the keyboard takes over, so the
// post_id watch effect below does not fight the cursor.
function dropPostIdQuery() {
  if (route.query.post_id !== undefined) {
    const currentQuery = { ...route.query }
    delete currentQuery.post_id
    router.replace({ query: currentQuery })
  }
}

// ── The grid as one keyboard composite (listbox) ─────────────────────────
// Keys, cursor/anchor model and focus handling live in useGalleryGrid; see
// its header. The waterfall wrapper is the listbox and the only Tab stop.
const postIds = computed(() => posts.value.map(post => post.id))
const gridEl = computed<HTMLElement | null>(() => waterfallWrapperDom.value ?? null)
const grid = useGalleryGrid({
  container: gridEl,
  scroller: galleryScrollEl,
  ids: postIds,
  layout: layoutData,
  enabled: inGridScope,
  open: id => router.push(`/post/${id}`),
  requestDelete,
  contextMenu: true,
  onMove: dropPostIdQuery,
})

// With focus outside the grid (on <body> after a load, or on a non-widget),
// the arrows / Enter / Delete / Mod+A still drive the grid, as they always
// have; the first arrow moves focus into it. Foreign widgets and text fields
// keep their keys (handleHotkey's default guards).
useEventListener(globalThis, 'keydown', (e: KeyboardEvent) => {
  const el = gridEl.value
  if (!inGridScope() || !el || (e.target instanceof Node && el.contains(e.target))) {
    return
  }
  grid.handleOutsideKey(e)
})

// Escape clears the selection from anywhere in the gallery (inside the grid
// the listbox handles it first). Open layers swallow Escape before this.
useHotkey('Escape', () => clearSelection(), {
  when: () => inGridScope() && selectedCount.value > 0,
  allowInWidgets: true,
})

const gridName = computed(() => {
  if (route.name === 'dir') {
    const folder = route.params.folder
    const parts = Array.isArray(folder) ? folder : [folder]
    const last = parts.findLast(Boolean)
    if (last) {
      return last
    }
  }
  if (route.name === 'recently') {
    return t('nav.recently')
  }
  return route.path === '/random' ? t('nav.random') : t('nav.all')
})
const gridLabel = computed(() => isTextSearchActive.value
  ? t('gallery.gridLabelSearch', { query: textSearchPrompt.value })
  : t('gallery.gridLabel', { name: gridName.value }))
// Unknown (-1) while more pages can still arrive.
const gridSetSize = computed(() => (!isTextSearchActive.value && infinityPostsQuery.hasNextPage.value) ? -1 : posts.value.length)

// Batch rating via 1–5, registered through the shared score-hotkey scope so it
// stays mutually exclusive with the detail page's per-post scoring.
const queryClient = useQueryClient()
const { pushToast } = useToast()

async function applyScoreToSelection(score: number) {
  const ids = selectedIdList.value
  if (ids.length === 0) {
    return
  }
  await commitScore(queryClient, posts.value, ids, score)
}

useScoreHotkeys('grid', applyScoreToSelection)

const shouldScroll = ref(true)
watchEffect(async () => {
  if (route.query.post_id) {
    // 如果有 post_id 参数，则选中这个 post，并且滚动到这个 post
    const postId = Number(route.query.post_id)
    if (posts.value.length === 0) {
      return
    }
    const postIndex = posts.value.findIndex(post => post.id === postId)
    if (postIndex === -1 && !infinityPostsQuery.hasNextPage.value) {
      // 保留现有的查询参数，只清除 post_id
      const currentQuery = { ...route.query }
      delete currentQuery.post_id
      await router.replace({ query: currentQuery })
      return
    }
    if (postId) {
      const postLayout = waterfallRef.value?.layoutData?.[postIndex]
      if (postLayout) {
        const res = document.querySelector(`#post-item-${postId}`)
        if (!res && shouldScroll.value) {
          waterfallWrapperDom.value?.scrollTo({
            top: postLayout.y,
            behavior: 'smooth',
          })
        }
        shouldScroll.value = false
        selectOnly(postId)
        setGridCursor(postId)
      }
    }
  }
})

// FIXME: 滚动到指定元素，但是有 Bug，会导致无法通过前进后退变更路由
// 如果 selectedPostIdSet 只有一个元素，则变更路由，但是不要滚动
// watchEffect(() => {
//   if (selectedPostIdSet.value.size === 1) {
//     const postId = selectedPostIdSet.value.values().next().value
//     if (postId) {
//       router.push({ query: { post_id: postId } })
//     }
//   }
// })

// Titles resolved through t() inside the computed so a locale switch rebuilds
// the menu — PMenu takes plain strings, not message keys.
const menuData = computed<PMenuItem[]>(() => {
  if (selectedCount.value > 0) {
    return [
      {
        role: 'label',
        title: t('gallery.menuActions'),
      },
      {
        value: 'rotate-clockwise',
        title: t('gallery.menuRotateCw'),
        icon: 'i-fluent-arrow-rotate-clockwise-24-regular',
      },
      {
        value: 'rotate-counterclockwise',
        title: t('gallery.menuRotateCcw'),
        icon: 'i-fluent-arrow-rotate-counterclockwise-24-regular',
      },
      { role: 'divider' },
      {
        value: 'delete',
        title: t('gallery.menuDelete'),
        icon: 'i-tabler-trash',
      },
    ]
  }
  return [
    {
      role: 'label',
      title: t('gallery.menuNoSelection'),
    },
  ]
})

const showDeleteConfirm = ref(false)
// Snapshot the ids when the dialog opens (instead of re-reading the live
// selection on confirm) so the count shown is exactly what gets deleted, even
// if the selection changes while the dialog is up (e.g. Ctrl+A still works).
const pendingDeleteIds = ref<number[]>([])
const isDeleting = ref(false)

function requestDelete() {
  const ids = selectedIdList.value
  if (ids.length === 0) {
    return
  }
  pendingDeleteIds.value = ids
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (isDeleting.value) {
    return
  }
  const ids = pendingDeleteIds.value
  if (ids.length === 0) {
    showDeleteConfirm.value = false
    return
  }
  isDeleting.value = true
  // Where the cursor lands: the next surviving post (else the previous one),
  // computed against the order before the list shrinks.
  const next = nextCursorAfterRemoval(postIds.value, ids, gridCursorId.value)
  try {
    await deletePosts(queryClient, ids)
    if (next === null) {
      clearSelection()
    }
    else {
      selectOnly(next)
    }
    setGridCursor(next)
    announce(t('gallery.deletedAnnounce', { n: ids.length }, ids.length))
    settleFocusAfterDelete(next)
  }
  catch {
    // The toast is itself announced (live region), so no separate announce.
    pushToast({ type: 'error', message: t('gallery.deleteFailed'), duration: 6000, closeable: true })
  }
  finally {
    isDeleting.value = false
    showDeleteConfirm.value = false
  }
}

// After the dialog closes (it returns focus itself) and the list has
// re-laid out: reveal the new cursor, and pull focus back into the grid if it
// fell to <body> (e.g. the deleted thumbnail's context menu was the origin).
function settleFocusAfterDelete(next: number | null) {
  requestAnimationFrame(() => {
    if (next !== null) {
      grid.reveal(next)
    }
    const active = document.activeElement
    if (!active || active === document.body) {
      grid.focusGrid()
    }
  })
}

function cancelDelete() {
  showDeleteConfirm.value = false
}

async function onMenuSelect(value: string | number | symbol) {
  const ids = selectedIdList.value
  switch (value) {
    case 'rotate-clockwise': {
      await commitRotate(queryClient, ids, true)
      break
    }
    case 'rotate-counterclockwise': {
      await commitRotate(queryClient, ids, false)
      break
    }
    case 'delete': {
      requestDelete()
      break
    }
  }
}

// ── 无限滚动 ────────────────────────────────────────────────────────────
// Text search returns one fixed result set (no paging), so the sentinel only
// exists on the regular list.
const canLoadMore = computed(() =>
  !isTextSearchActive.value
  && posts.value.length > 0
  && infinityPostsQuery.hasNextPage.value,
)
const loadMoreSentinel = ref<HTMLElement>()

useIntersectionObserver(
  loadMoreSentinel,
  ([entry]) => {
    if (!entry?.isIntersecting) {
      return
    }
    // hasNextPage/isFetchingNextPage guard against re-entry: the observer can
    // fire again before the in-flight page resolves and grows the list.
    if (infinityPostsQuery.hasNextPage.value && !infinityPostsQuery.isFetchingNextPage.value) {
      infinityPostsQuery.fetchNextPage()
    }
  },
  {
    // Root is the PScrollArea's inner scroller, not the viewport.
    root: galleryScrollEl,
    // Start fetching while the sentinel is still ~a screen below the fold.
    rootMargin: '600px',
  },
)

// Persist gallery scrollTop across navigations to /post/:id and back. Home.vue
// has no <keep-alive>, so MainSection unmounts on entry to a post detail and
// remounts on Esc/back — without this, scrollTop resets to 0.
useEventListener(galleryScrollEl, 'scroll', () => {
  const el = galleryScrollEl.value
  if (el) {
    galleryScrollPositions.set(route.fullPath, el.scrollTop)
  }
}, { passive: true })

onBeforeRouteLeave((_to, from) => {
  const el = galleryScrollEl.value
  if (el) {
    galleryScrollPositions.set(from.fullPath, el.scrollTop)
  }
})

// Coming back from a post (page or overlay): put the cursor + selection on
// the post last viewed there, scroll it into view (centred if it's off-screen)
// and, if focus was dropped on <body>, give it back to the grid. Waits for the
// scroll-position restore below so the two don't fight, and for the layout.
let scrollRestored = false
function restoreLastViewed() {
  const id = lastViewedPostId.value
  if (id === null || !scrollRestored) {
    return
  }
  const index = postIds.value.indexOf(id)
  if (index === -1) {
    // Not in this list (deleted, filtered out, another folder): give up once
    // nothing is loading any more.
    const fetching = infinityPostsQuery.isFetching.value || textSearchQueryResult.isFetching.value
    if (!fetching) {
      lastViewedPostId.value = null
    }
    return
  }
  if (!layoutData.value?.[index]) {
    return
  }
  lastViewedPostId.value = null
  selectOnly(id)
  setGridCursor(id)
  grid.reveal(id, { align: 'center-if-hidden' })
  // Focus goes to the grid unless the user already put it on a control. The
  // <main> landmark itself doesn't count: App.vue parks focus there on route
  // changes, which can land before this restore runs.
  const active = document.activeElement
  if (!active || active === document.body || active.id === 'main-content') {
    grid.focusGrid()
  }
}
watch([lastViewedPostId, postIds, layoutData], restoreLastViewed, { flush: 'post' })

function finishScrollRestore() {
  scrollRestored = true
  restoreLastViewed()
}

onMounted(() => {
  const targetTop = galleryScrollPositions.get(route.fullPath)
  if (!targetTop) {
    finishScrollRestore()
    return
  }
  // Waterfall layout fills in asynchronously after react-query hands back cached
  // posts; rAF-tick until scrollHeight is tall enough for scrollTop to stick.
  let attempts = 0
  const tick = () => {
    const el = galleryScrollEl.value
    if (!el) {
      if (attempts++ < 60) {
        requestAnimationFrame(tick)
      }
      else {
        finishScrollRestore()
      }
      return
    }
    if (el.scrollHeight - el.clientHeight >= targetTop) {
      el.scrollTop = targetTop
      finishScrollRestore()
      return
    }
    if (attempts++ < 60) {
      requestAnimationFrame(tick)
    }
    else {
      finishScrollRestore()
    }
  }
  requestAnimationFrame(tick)
})
</script>

<template>
  <PScrollArea
    ref="mainSectionRef"
    class="flex flex-grow basis-0 flex-col relative"
  >
    <PSelectArea
      :target="mainSectionRef"
      @select-change="onSelectChange"
      @select-end="onSelectEnd"
    />
    <PMenu
      :data="menuData"
      trigger="contextmenu"
      :aria-label="$t('gallery.menuActions')"
      class="shrink-0 grow-1 basis-0 h-full w-full"
      @select="onMenuSelect"
    >
      <FolderSection />
      <!-- The status slot (loading / empty / error) has its own stable wrapper
           (display: contents — no layout box). Without it, switching between
           these v-if branches makes Vue re-insert the grid below them, and a
           DOM move blurs the focused grid (focus fell to <body> whenever a
           search started). -->
      <div class="contents">
        <PEmpty
          v-if="isTextSearchActive && textSearchQueryResult.isLoading.value"
          icon="i-tabler-loader animate-spin"
          class="p-16"
        >
          {{ $t('gallery.searching', { query: textSearchPrompt }) }}
        </PEmpty>
        <PEmpty
          v-else-if="isTextSearchActive && textSearchQueryResult.error.value"
          icon="i-tabler-alert-circle"
          class="text-danger p-16"
        >
          {{ $t('gallery.searchFailed') }}
        </PEmpty>
        <PEmpty
          v-else-if="isTextSearchActive && posts.length === 0"
          icon="i-tabler-mood-empty"
          class="p-16"
        >
          {{ $t('gallery.noTextMatch', { query: textSearchPrompt }) }}
        </PEmpty>
        <!-- First page in flight: draw the masonry skeleton at the real column
             geometry so the grid doesn't jump when the data lands. -->
        <GallerySkeleton
          v-else-if="!isTextSearchActive && infinityPostsQuery.isLoading.value && posts.length === 0"
          :cols="cols"
          :item-width="waterfallItemWidth"
        />
        <PEmpty
          v-else-if="posts.length === 0"
          icon="i-tabler-photo-off"
          class="p-16"
        >
          {{ $t('gallery.noPosts') }}
        </PEmpty>
      </div>

      <!-- The waterfall wrapper is the listbox: one Tab stop, focus stays on
           it, the cursor thumbnail is its aria-activedescendant. -->
      <Waterfall
        ref="waterfallRef"
        class="waterfall-wrapper select-none focus:outline-none"
        role="listbox"
        tabindex="0"
        aria-multiselectable="true"
        :aria-label="gridLabel"
        data-gallery-grid
        :scroll-element="mainSectionRef"
        :items="items"
        :item-width="waterfallItemWidth"
        :cols="cols"
        :gap="GRID_GAP"
        :padding-x="GRID_PAD"
        :padding-y="GRID_PAD"
        @pointerdown="emptyPointerDown"
      >
        <PostItem
          v-for="(post, index) in posts"
          :id="`post-item-${post.id}`"
          :key="post.id"
          :post="post"
          :aria-posinset="index + 1"
          :aria-setsize="gridSetSize"
        />
      </Waterfall>
      <!-- Infinite-scroll sentinel. The observer (see script) fires while this
           is still 600px below the fold, so the next page is usually already in
           by the time the user reaches here. The button stays as a manual
           fallback for when the observer never fires (or the fetch failed). -->
      <div
        v-if="canLoadMore"
        ref="loadMoreSentinel"
        class="p-4 flex justify-center"
      >
        <div
          v-if="infinityPostsQuery.isFetchingNextPage.value"
          class="text-sm text-fg-subtle flex gap-2 items-center"
        >
          <i class="i-tabler-loader animate-spin" aria-hidden="true" />
          {{ $t('gallery.loadingPosts') }}
        </div>
        <PButton
          v-else
          size="sm"
          variant="ghost"
          @click="infinityPostsQuery.fetchNextPage()"
        >
          {{ $t('gallery.loadMore') }}
        </PButton>
      </div>
    </PMenu>
    <POverlay
      v-if="showDeleteConfirm"
      class="flex items-center justify-center"
      @click.self="cancelDelete"
    >
      <!-- Same dialog copy as the /post/:id page — reuses the post.deleteDialog* keys. -->
      <PDialog
        :title="$t('post.deleteDialogTitle')"
        :confirm-label="isDeleting ? $t('post.deleteDialogDeleting') : $t('post.deleteDialogConfirm', { n: pendingDeleteIds.length })"
        :cancel-label="$t('common.cancel')"
        variant="danger"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
      >
        <i18n-t keypath="post.deleteDialogBody" tag="p" scope="global" :plural="pendingDeleteIds.length">
          <template #n>
            <span class="text-fg font-medium tabular-nums">{{ pendingDeleteIds.length }}</span>
          </template>
        </i18n-t>
      </PDialog>
    </POverlay>
  </PScrollArea>
</template>
