<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import type { PMenuItem } from '@/ui'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { refDebounced } from '@vueuse/core'
import { logicAnd } from '@vueuse/math'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { Waterfall } from 'vue-wf'
import { v2DeletePosts, v2SearchPostsByText } from '@/api'
import Dialog from '@/components/Dialog.vue'
import { useRotateImageMutation } from '@/composables/mutations/useRotateImageMutation'
import { currentPostList, galleryScrollPositions, patchPostsInListCache, postFilter, queryKeys, selectedPostIdSet, showPostDetail, textSearchQuery, updateScoreForSelectedPosts, useInfinityPostsQuery, waterfallRowCount } from '@/shared'
import { POverlay } from '@/ui'
import { isImageExtension } from '@/utils'

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
    selectedPostIdSet.value = new Set()
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

const canHandleGridKeys = computed(() => notUsingInput.value && !showPostDetail.value)

function scrollSelectedIntoView(postId: number) {
  // Defer to next tick so the DOM has the selection update committed.
  requestAnimationFrame(() => {
    document.querySelector(`#post-item-${postId}`)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    })
  })
}

type Direction = 'left' | 'right' | 'up' | 'down'

function findNeighborByCoords(curIdx: number, direction: Direction): number {
  const layout = layoutData.value
  if (!layout || layout.length === 0) {
    return -1
  }
  const cur = layout[curIdx]
  if (!cur) {
    return -1
  }
  const curCx = cur.x + cur.width / 2
  const curCy = cur.y + cur.height / 2

  if (direction === 'left' || direction === 'right') {
    // Snap to the adjacent column: among candidates strictly on the
    // requested side, find the smallest |dx| (that's the next column),
    // then pick the one with the smallest vertical distance within it.
    const tolerance = Math.max(2, cur.width / 2)
    let minDx = Number.POSITIVE_INFINITY
    for (const [i, el] of layout.entries()) {
      if (i === curIdx) {
        continue
      }
      const dx = (el.x + el.width / 2) - curCx
      if (direction === 'left' ? dx < -1 : dx > 1) {
        const abs = Math.abs(dx)
        if (abs < minDx) {
          minDx = abs
        }
      }
    }
    if (!Number.isFinite(minDx)) {
      return -1
    }
    let best = -1
    let bestDy = Number.POSITIVE_INFINITY
    for (const [i, el] of layout.entries()) {
      if (i === curIdx) {
        continue
      }
      const dx = (el.x + el.width / 2) - curCx
      const correctSide = direction === 'left' ? dx < -1 : dx > 1
      if (!correctSide) {
        continue
      }
      if (Math.abs(Math.abs(dx) - minDx) > tolerance) {
        continue
      }
      const dy = Math.abs((el.y + el.height / 2) - curCy)
      if (dy < bestDy) {
        bestDy = dy
        best = i
      }
    }
    return best
  }

  // Up / down: prefer staying in the same column, but allow nearby columns
  // when there's no overlapping candidate in the current column.
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  for (const [i, el] of layout.entries()) {
    if (i === curIdx) {
      continue
    }
    const dx = (el.x + el.width / 2) - curCx
    const dy = (el.y + el.height / 2) - curCy
    if (direction === 'up' ? dy >= -1 : dy <= 1) {
      continue
    }
    const score = Math.abs(dy) + Math.abs(dx) * 2
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

function moveSelection(direction: Direction) {
  if (posts.value.length === 0) {
    return
  }
  const ids = posts.value.map(p => p.id).filter((id): id is number => id !== undefined)
  if (ids.length === 0) {
    return
  }
  const current = [...selectedPostIdSet.value].filter((id): id is number => id !== undefined)
  let curIdx: number
  if (current.length === 0) {
    curIdx = direction === 'right' || direction === 'down' ? 0 : posts.value.length - 1
  }
  else {
    const anchor = current.at(-1)!
    const idx = posts.value.findIndex(p => p.id === anchor)
    curIdx = idx === -1 ? 0 : idx
  }
  const nextIdx = findNeighborByCoords(curIdx, direction)
  if (nextIdx === -1) {
    return
  }
  const nextId = posts.value[nextIdx]?.id
  if (nextId === undefined) {
    return
  }
  selectedPostIdSet.value = new Set([nextId])
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
  const ids = [...selectedPostIdSet.value].filter((id): id is number => id !== undefined)
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
  if (selectedPostIdSet.value.size > 0) {
    selectedPostIdSet.value = new Set()
  }
})

// Add keyboard shortcuts for batch rating
const { 1: one, 2: two, 3: three, 4: four, 5: five } = useMagicKeys()
const queryClient = useQueryClient()

async function applyScoreToSelection(score: number) {
  if (selectedPostIdSet.value.size === 0) {
    return
  }
  const selectedIds = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]
  await updateScoreForSelectedPosts(score)
  patchPostsInListCache(queryClient, selectedIds, { score })
  // One predicate sweep covers count/stats caches plus every selected
  // post-detail cache; the old loop was O(selected) full cache scans.
  const idSet = new Set(selectedIds)
  queryClient.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey
      if (!Array.isArray(k)) {
        return false
      }
      if (k[0] === 'count' && k[1] === 'score') {
        return true
      }
      if (k[0] === 'posts' && k[1] === 'stats') {
        return true
      }
      return k[0] === 'post' && typeof k[1] === 'number' && idSet.has(k[1])
    },
  })
}

whenever(logicAnd(one, notUsingInput), () => applyScoreToSelection(1))
whenever(logicAnd(two, notUsingInput), () => applyScoreToSelection(2))
whenever(logicAnd(three, notUsingInput), () => applyScoreToSelection(3))
whenever(logicAnd(four, notUsingInput), () => applyScoreToSelection(4))
whenever(logicAnd(five, notUsingInput), () => applyScoreToSelection(5))

whenever(logicAnd(Ctrl_A, notUsingInput), () => {
  selectedPostIdSet.value = new Set(posts.value.map(post => post.id))
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
        selectedPostIdSet.value = new Set([postId])
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
  if (selectedPostIdSet.value.size > 0) {
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
const pendingDeleteCount = ref(0)
const isDeleting = ref(false)

function requestDelete() {
  const count = [...selectedPostIdSet.value].filter(id => id !== undefined).length
  if (count === 0) {
    return
  }
  pendingDeleteCount.value = count
  showDeleteConfirm.value = true
}

async function confirmDelete() {
  if (isDeleting.value) {
    return
  }
  const ids = [...selectedPostIdSet.value].filter(id => id !== undefined) as number[]
  if (ids.length === 0) {
    showDeleteConfirm.value = false
    return
  }
  isDeleting.value = true
  try {
    const batchSize = 100
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize)
      await v2DeletePosts({
        query: {
          ids: batch,
        },
      })
    }
    queryClient.invalidateQueries({ queryKey: queryKeys.postsRoot })
    queryClient.invalidateQueries({ queryKey: queryKeys.countRoot('score') })
    queryClient.invalidateQueries({ queryKey: queryKeys.countRoot('rating') })
    queryClient.invalidateQueries({ queryKey: queryKeys.countRoot('extension') })
    selectedPostIdSet.value = new Set()
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

const rotateImageMutation = useRotateImageMutation()
function onMenuSelect(value: string | number | symbol) {
  const selectedPostIds = [...selectedPostIdSet.value]
  for (const postId of selectedPostIds) {
    if (!postId) {
      continue
    }
    switch (value) {
      case 'rotate-clockwise': {
        rotateImageMutation.mutate({ postId, clockwise: true })
        break
      }
      case 'rotate-counterclockwise': {
        rotateImageMutation.mutate({ postId, clockwise: false })
        break
      }
      case 'delete': {
        requestDelete()
        return
      }
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
  <ScrollArea
    ref="mainSectionRef"
    class="flex flex-grow basis-0 flex-col relative"
  >
    <SelectArea
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
      <div v-else-if="isTextSearchActive && posts.length === 0">
        <div class="p-16 text-center op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-mood-empty text-2xl" />
          <div class="text-sm">
            No images matched “{{ textSearchPrompt }}”.
          </div>
          <div class="text-xs">
            Try a different description or clear the text search box.
          </div>
        </div>
      </div>
      <div v-else-if="!isTextSearchActive && infinityPostsQuery.isLoading.value && posts.length === 0">
        <div class="p-16 text-center op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-loader text-2xl animate-spin" />
          <div class="text-sm">
            Loading posts…
          </div>
        </div>
      </div>
      <div v-else-if="posts.length === 0">
        <div class="p-16 text-center op-50 flex flex-col gap-2 items-center">
          <i class="i-tabler-photo-off text-2xl" />
          <div class="text-sm">
            No posts found
          </div>
          <div class="text-xs">
            Try a different folder, or adjust the filters.
          </div>
        </div>
      </div>

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
      <Dialog
        title="Delete selected posts?"
        :confirm-label="isDeleting ? 'Deleting…' : `Delete ${pendingDeleteCount}`"
        cancel-label="Cancel"
        variant="danger"
        @confirm="confirmDelete"
        @cancel="cancelDelete"
      >
        <p>
          This will permanently delete
          <span class="text-fg font-medium tabular-nums">{{ pendingDeleteCount }}</span>
          post<span v-if="pendingDeleteCount !== 1">s</span>. This cannot be undone.
        </p>
      </Dialog>
    </POverlay>
  </ScrollArea>
</template>
