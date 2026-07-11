<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import type { PMenuItem } from '@/ui'
import type { GridCell, GridDirection } from '@/utils/gridGeometry'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { logicAnd } from '@vueuse/math'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Waterfall } from 'vue-wf'
import { v2SearchPostsByText } from '@/api'
import { clear as clearSelection, commitRotate, commitScore, currentPostList, deletePosts, focusedTreeFolder, galleryScrollPositions, isAnyDialogOpen, postFilter, queryKeys, selectAll, selectedCount, selectedIdList, selectOnly, showPostDetail, textSearchQuery, useInfinityPostsQuery, waterfallRowCount } from '@/shared'
import { POverlay } from '@/ui'
import PDialog from '@/ui/PDialog.vue'
import { isImageExtension } from '@/utils'
import { findGridNeighbor } from '@/utils/gridGeometry'

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
const waterfallItemWidth = computed(() => {
  return Math.floor((waterfallWrapperBounds.width.value - 8 * 2 - 24 * (waterfallRowCount.value - 1)) / waterfallRowCount.value)
})
const cols = computed(() => Math.floor((waterfallWrapperBounds.width.value + 20 - 8 * 2) / (waterfallItemWidth.value + 20)))
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

const { Ctrl_A } = useMagicKeys()
const activeElement = useActiveElement()
const notUsingInput = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA')

// Keep the shared list in sync so PostDetail / Post.vue can navigate prev/next
watchEffect(() => {
  currentPostList.value = posts.value
})

// Grid hotkeys stand down while a confirm dialog is open (Enter would
// otherwise open the post detail instead of confirming the delete) and while
// a folder-tree row has focus (Delete targets that folder, not the selection).
const canHandleGridKeys = computed(() => notUsingInput.value && !showPostDetail.value && !isAnyDialogOpen.value && !focusedTreeFolder.value)

function scrollSelectedIntoView(postId: number) {
  // Defer to next tick so the DOM has the selection update committed.
  requestAnimationFrame(() => {
    document.querySelector(`#post-item-${postId}`)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })
  })
}

type Direction = GridDirection

function moveSelection(direction: Direction) {
  const layout = layoutData.value
  if (posts.value.length === 0 || !layout || layout.length === 0) {
    return
  }
  // Pair each laid-out rect with its post id, preserving visual/DOM order so
  // the pure navigator's tie-breaking (array order) matches the grid.
  const cells: GridCell[] = []
  for (const [i, el] of layout.entries()) {
    const id = posts.value[i]?.id
    if (id === undefined) {
      continue
    }
    cells.push({ id, rect: { x: el.x, y: el.y, width: el.width, height: el.height } })
  }
  if (cells.length === 0) {
    return
  }
  // Resolve the id the move starts from: with no selection, start at the
  // corner (first for right/down, last for left/up); otherwise the last-
  // selected anchor, falling back to the first post if it's no longer present.
  const current = selectedIdList.value
  let startIdx: number
  if (current.length === 0) {
    startIdx = direction === 'right' || direction === 'down' ? 0 : posts.value.length - 1
  }
  else {
    const anchor = current.at(-1)!
    const idx = posts.value.findIndex(p => p.id === anchor)
    startIdx = idx === -1 ? 0 : idx
  }
  const startId = posts.value[startIdx]?.id
  if (startId === undefined) {
    return
  }
  const nextId = findGridNeighbor(cells, startId, direction)
  if (nextId === undefined) {
    return
  }
  selectOnly(nextId)
  // Drop stale post_id from the URL so the watch effect does not fight us.
  if (route.query.post_id !== undefined) {
    const currentQuery = { ...route.query }
    delete currentQuery.post_id
    router.replace({ query: currentQuery })
  }
  scrollSelectedIntoView(nextId)
}

onKeyStroke(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], (e) => {
  if (!canHandleGridKeys.value) {
    return
  }
  let direction: Direction | null = null
  switch (e.key) {
    case 'ArrowLeft': { direction = 'left'
      break }
    case 'ArrowRight': { direction = 'right'
      break }
    case 'ArrowUp': { direction = 'up'
      break }
    case 'ArrowDown': { direction = 'down'
      break }
  }
  if (!direction) {
    return
  }
  e.preventDefault()
  moveSelection(direction)
})

onKeyStroke('Enter', (e) => {
  if (!canHandleGridKeys.value) {
    return
  }
  const ids = selectedIdList.value
  if (ids.length !== 1) {
    return
  }
  e.preventDefault()
  router.push(`/post/${ids[0]}`)
})

onKeyStroke('Escape', () => {
  if (!canHandleGridKeys.value) {
    return
  }
  if (selectedCount.value > 0) {
    clearSelection()
  }
})

// Add keyboard shortcuts for batch rating
const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
const queryClient = useQueryClient()

async function applyScoreToSelection(score: number) {
  const ids = selectedIdList.value
  if (ids.length === 0) {
    return
  }
  await commitScore(queryClient, posts.value, ids, score)
}

whenever(logicAnd(one, notUsingInput), () => applyScoreToSelection(1))
whenever(logicAnd(two, notUsingInput), () => applyScoreToSelection(2))
whenever(logicAnd(three, notUsingInput), () => applyScoreToSelection(3))
whenever(logicAnd(four, notUsingInput), () => applyScoreToSelection(4))
whenever(logicAnd(five, notUsingInput), () => applyScoreToSelection(5))

whenever(logicAnd(Ctrl_A, notUsingInput), () => {
  selectAll(posts.value.map(post => post.id))
})

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

const menuData = computed<PMenuItem[]>(() => {
  if (selectedCount.value > 0) {
    return [
      {
        role: 'label',
        title: 'Post Actions',
      },
      {
        value: 'rotate-clockwise',
        title: 'Rotate Clockwise',
        icon: 'i-fluent-arrow-rotate-clockwise-24-regular',
      },
      {
        value: 'rotate-counterclockwise',
        title: 'Rotate Counterclockwise',
        icon: 'i-fluent-arrow-rotate-counterclockwise-24-regular',
      },
      { role: 'divider' },
      {
        value: 'delete',
        title: 'Delete',
        icon: 'i-tabler-trash',
      },
    ]
  }
  return [
    {
      role: 'label',
      title: 'No Post Selected',
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
  try {
    await deletePosts(queryClient, ids)
    clearSelection()
  }
  finally {
    isDeleting.value = false
    showDeleteConfirm.value = false
  }
}

function cancelDelete() {
  showDeleteConfirm.value = false
}

onKeyStroke('Delete', (e) => {
  if (!canHandleGridKeys.value) {
    return
  }
  e.preventDefault()
  requestDelete()
})

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
const mainSectionRef = ref<HTMLElement>()

// Persist gallery scrollTop across navigations to /post/:id and back. Home.vue
// has no <keep-alive>, so MainSection unmounts on entry to a post detail and
// remounts on Esc/back — without this, scrollTop resets to 0.
const galleryScrollEl = computed<HTMLElement | undefined>(() => (mainSectionRef.value as unknown as { $el?: HTMLElement } | undefined)?.$el)

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

onMounted(() => {
  const targetTop = galleryScrollPositions.get(route.fullPath)
  if (!targetTop) {
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
      return
    }
    if (el.scrollHeight - el.clientHeight >= targetTop) {
      el.scrollTop = targetTop
      return
    }
    if (attempts++ < 60) {
      requestAnimationFrame(tick)
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
      class="shrink-0 grow-1 basis-0 h-full w-full"
      @select="onMenuSelect"
    >
      <FolderSection />
      <div v-if="isTextSearchActive && textSearchQueryResult.isLoading.value">
        <div class="p-16 op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-loader text-2xl animate-spin" />
          <div class="text-sm">
            Searching for “{{ textSearchPrompt }}”
          </div>
        </div>
      </div>
      <div v-else-if="isTextSearchActive && textSearchQueryResult.error.value">
        <div class="text-danger p-16 text-center op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-alert-circle text-2xl" />
          <div class="text-sm">
            Failed to run text search. Please try again.
          </div>
        </div>
      </div>
      <PEmpty
        v-else-if="isTextSearchActive && posts.length === 0"
        icon="i-tabler-mood-empty"
        class="p-16"
      >
        {{ $t('gallery.noTextMatch', { query: textSearchPrompt }) }}
      </PEmpty>
      <div v-else-if="!isTextSearchActive && infinityPostsQuery.isLoading.value && posts.length === 0">
        <div class="p-16 text-center op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-loader text-2xl animate-spin" />
          <div class="text-sm">
            Loading posts…
          </div>
        </div>
      </div>
      <PEmpty
        v-else-if="posts.length === 0"
        icon="i-tabler-photo-off"
        class="p-16"
      >
        {{ $t('gallery.noPosts') }}
      </PEmpty>

      <Waterfall
        ref="waterfallRef"
        class="waterfall-wrapper select-none"
        :scroll-element="mainSectionRef"
        :items="items"
        :item-width="waterfallItemWidth"
        :cols="cols"
        :gap="24"
        :padding-x="8"
        :padding-y="8"
        :y-gap="36"
        @pointerdown="emptyPointerDown"
      >
        <PostItem
          v-for="post in posts"
          :id="`post-item-${post.id}`"
          :key="post.id"
          :post="post"
        />
      </Waterfall>
      <div
        v-if="!isTextSearchActive && posts.length > 0 && infinityPostsQuery.hasNextPage.value"
        class="p-4 flex justify-center"
      >
        <PButton
          :loading="infinityPostsQuery.isLoading.value"
          @click="infinityPostsQuery.fetchNextPage()"
        >
          Load More
        </PButton>
      </div>
    </PMenu>
    <POverlay
      v-if="showDeleteConfirm"
      class="flex items-center justify-center"
      @click.self="cancelDelete"
    >
      <PDialog
        title="Delete selected posts?"
        :confirm-label="isDeleting ? 'Deleting…' : `Delete ${pendingDeleteIds.length}`"
        cancel-label="Cancel"
        variant="danger"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
      >
        <p>
          This will permanently delete
          <span class="text-fg font-medium tabular-nums">{{ pendingDeleteIds.length }}</span>
          post<span v-if="pendingDeleteIds.length !== 1">s</span>. This cannot be undone.
        </p>
      </PDialog>
    </POverlay>
  </PScrollArea>
</template>
