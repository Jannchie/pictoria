<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { useRoute, useRouter } from 'vue-router'
import { v2TouchPost } from '@/api'
import ArthashPlaceholder from '@/components/ArthashPlaceholder.vue'
import Dialog from '@/components/Dialog.vue'
import PostDetail from '@/components/PostDetail.vue'
import { bottomBarInfo, currentPostList, deletePosts, enableArthash, enableFancyPlaceholder, isAnyDialogOpen, selectedPostIdSet, showPostDetail, similarPostList } from '@/shared'
import { POverlay } from '@/ui'
import { getPostImageURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'

const route = useRoute()
const router = useRouter()
const postId = computed(() => Number.parseInt(route.params.postId as string))
// Preload the neighbouring originals so ←→ navigation (page and fullscreen
// overlay) swaps images instantly from cache.
useAdjacentImagePreload(postId)
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()

// Drag-box selection over the similar-posts grid, unified with the list
// waterfall (MainSection). SimilarPosts owns/renders the Waterfall and exposes
// its instance; we read its layout here to map the drag rectangle to post ids.
// The query shares the ['similarPosts'] cache, so `similarPosts` is the exact
// same ordered array SimilarPosts renders.
const similarPostsRef = ref<{ waterfall: any } | null>(null)
const similarWaterfall = computed(() => similarPostsRef.value?.waterfall ?? null)
const similarQuery = useSimilarPostsQuery(postId)
const similarPosts = computed(() => similarQuery.data.value ?? [])
const { onSelectChange, onSelectEnd } = useWaterfallSelection(similarWaterfall, similarPosts)

// Publish the similar grid so the right-panel multi-select view can resolve
// thumbnails/stats for selected similar posts — identical to how the gallery
// feeds it from currentPostList. The main post never lands in a multi-select
// (see the postId watch below, which clears selection rather than seeding it),
// so the panel's selection is always wholly contained here, just like the list.
watchEffect(() => {
  similarPostList.value = similarPosts.value
})
onUnmounted(() => {
  similarPostList.value = []
})
const imgRef = ref<HTMLImageElement>()
const imageLoaded = ref(false)

function getPostColor(post: { colors: { color: number, order: number }[] }) {
  if (post.colors && post.colors.length > 0) {
    return colorNumToHex(post.colors.toSorted((a, b) => {
      return a.order - b.order
    })[0].color)
  }
  return 'primary'
}

const imageAspectRatio = computed(() => {
  const p = post.value
  if (!p) {
    return null
  }
  if (p.aspectRatio) {
    return p.aspectRatio
  }
  if (p.width && p.height) {
    return p.width / p.height
  }
  return null
})

const containerStyle = computed(() => {
  const p = post.value
  if (!p) {
    return {}
  }
  const style: Record<string, string> = {}
  const ratio = imageAspectRatio.value
  if (ratio) {
    style.aspectRatio = String(ratio)
    const widthCaps = ['100%', `calc(80vh * ${ratio})`]
    if (p.width) {
      widthCaps.unshift(`${p.width}px`)
    }
    style.width = `min(${widthCaps.join(', ')})`
  }
  else {
    style.width = '100%'
    if (p.width) {
      style.maxWidth = `${p.width}px`
    }
  }
  const color = getPostColor(p)
  if (color !== 'primary') {
    style.backgroundColor = color
  }
  return style
})

function onImageLoad() {
  imageLoaded.value = true
}

watch(postId, (id) => {
  imageLoaded.value = false
  if (Number.isFinite(id)) {
    // 清空选区而不是把主图塞进去：useFocusedPost 在选区为空时会回退到 URL 主图，
    // 侧边栏照样跟随主图（进入页面、键盘 ←→ 切换）。这样用户框选/Ctrl/Shift 点选
    // 相似图时，选区从空开始累积，只含相似图——与列表瀑布流的多选行为完全一致，
    // 不会再有主图残留导致侧边栏出现 “N/M in view” 的差异。
    selectedPostIdSet.value = new Set()
    v2TouchPost({ path: { post_id: id } }).catch(() => {})
  }
}, { immediate: true })

onMounted(() => {
  if (imgRef.value?.complete) {
    imageLoaded.value = true
  }
})

watchEffect(() => {
  if (postQuery.data.value) {
    bottomBarInfo.value = `Post ID: ${postQuery.data.value.id}, File Name: ${postQuery.data.value.fileName}`
  }
})

const activeElement = useActiveElement()
const notUsingInput = computed(() =>
  activeElement.value?.tagName !== 'INPUT'
  && activeElement.value?.tagName !== 'TEXTAREA')

// 确认弹窗打开时，页面级快捷键全部让位：Enter/Escape 归 Dialog（确认/
// 取消），否则 Enter 会顺手打开大图、Escape 会退回上一页。
const canHandlePageKeys = computed(() => notUsingInput.value && !showPostDetail.value && !isAnyDialogOpen.value)

function openOverlay() {
  const p = post.value
  if (!p) {
    return
  }
  showPostDetail.value = { ...p, width: p.width ?? 0, height: p.height ?? 0 }
}

function navigatePost(delta: -1 | 1) {
  const list = currentPostList.value
  if (list.length === 0) {
    return
  }
  const idx = list.findIndex(p => p.id === postId.value)
  if (idx === -1) {
    return
  }
  const nextIdx = Math.max(0, Math.min(list.length - 1, idx + delta))
  if (nextIdx === idx) {
    return
  }
  const next = list[nextIdx]
  if (next?.id !== undefined) {
    router.replace(`/post/${next.id}`)
  }
}

onKeyStroke('Escape', (e) => {
  if (!canHandlePageKeys.value) {
    return
  }
  e.preventDefault()
  router.back()
})

onKeyStroke(['ArrowLeft', 'ArrowRight'], (e) => {
  if (!canHandlePageKeys.value) {
    return
  }
  e.preventDefault()
  navigatePost(e.key === 'ArrowRight' ? 1 : -1)
})

onKeyStroke([' ', 'Enter'], (e) => {
  if (!canHandlePageKeys.value) {
    return
  }
  e.preventDefault()
  openOverlay()
})

// Delete 删除选中的相似图。详情页此前只有列表瀑布流(MainSection)能按 Delete，
// 相似图网格没接，所以这里补上——复用统一的 deletePosts（会刷新 similarPosts 缓存）。
const queryClient = useQueryClient()
const showDeleteConfirm = ref(false)
const isDeleting = ref(false)
const pendingDeleteIds = computed(() =>
  [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number'),
)

onKeyStroke('Delete', (e) => {
  if (!canHandlePageKeys.value || pendingDeleteIds.value.length === 0) {
    return
  }
  e.preventDefault()
  showDeleteConfirm.value = true
})

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
    // 选区可能含当前正在看的大图（点了主图）；删掉它后这个详情页就空了，删完返回
    // 上一页。只删相似图时留在原地，列表由 deletePosts 自动刷新。
    const removingCurrent = ids.includes(postId.value)
    await deletePosts(queryClient, ids)
    selectedPostIdSet.value = new Set()
    if (removingCurrent) {
      router.back()
    }
  }
  finally {
    isDeleting.value = false
    showDeleteConfirm.value = false
  }
}
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
  />
  <div
    v-if="post"
    class="flex flex-col h-full"
  >
    <div
      class="px-2 py-1 border-b border-border-default bg-bg flex gap-2 items-center justify-between"
    >
      <div class="flex flex-1 basis-0 items-center">
        <PButton
          icon
          size="sm"
          variant="ghost"
          aria-label="Back"
          @click="$router.back()"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
        </PButton>
      </div>
      <h1 class="text-sm text-fg font-medium min-w-0 truncate">
        {{ post.fileName }}
      </h1>
      <span class="flex-1 basis-0" />
    </div>
    <ScrollArea
      ref="scrollAreaRef"
      class="flex flex-grow flex-basis-0 flex-col gap-4 h-full w-full relative"
    >
      <SelectArea
        :target="scrollAreaRef"
        @select-change="onSelectChange"
        @select-end="onSelectEnd"
      />
      <div class="px-2 pt-3 flex justify-center">
        <div
          class="main-post-image rounded-lg cursor-pointer relative overflow-hidden"
          :class="{ 'main-post-selected': selectedPostIdSet.has(postId) }"
          :style="containerStyle"
          @click="selectedPostIdSet = new Set([postId])"
          @dblclick="showPostDetail = { ...post, width: post.width ?? 0, height: post.height ?? 0 }"
        >
          <img
            :key="post.id"
            ref="imgRef"
            :src="getPostImageURL(post)"
            :alt="post.fileName"
            :width="post.width ?? undefined"
            :height="post.height ?? undefined"
            fetchpriority="high"
            decoding="async"
            class="h-full w-full block transition-opacity duration-300 object-contain"
            :class="{ 'opacity-0': (!enableArthash || !post.arthash) && !imageLoaded }"
            @load="onImageLoad"
          >
          <ArthashPlaceholder
            v-if="enableArthash && post.arthash"
            :hash="post.arthash"
            :revealed="imageLoaded"
            :fancy="enableFancyPlaceholder"
          />
        </div>
      </div>
      <SimilarPosts
        v-if="scrollAreaRef"
        ref="similarPostsRef"
        class="w-full"
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </ScrollArea>
  </div>
  <POverlay
    v-if="showDeleteConfirm"
    class="flex items-center justify-center"
    @click.self="showDeleteConfirm = false"
  >
    <Dialog
      title="Delete selected posts?"
      :confirm-label="isDeleting ? 'Deleting…' : `Delete ${pendingDeleteIds.length}`"
      cancel-label="Cancel"
      variant="danger"
      @confirm="confirmDelete"
      @cancel="showDeleteConfirm = false"
    >
      <p>
        This will permanently delete
        <span class="text-fg font-medium tabular-nums">{{ pendingDeleteIds.length }}</span>
        post<span v-if="pendingDeleteIds.length !== 1">s</span>. This cannot be undone.
      </p>
    </Dialog>
  </POverlay>
</template>

<style lang="css" scoped>
.main-post-image {
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition:
    outline-color var(--p-duration-fast) var(--p-ease),
    box-shadow var(--p-duration-fast) var(--p-ease);
}
.main-post-selected {
  outline-color: var(--p-primary);
  box-shadow: 0 0 0 4px rgb(var(--p-primary-rgb) / 0.18);
}
</style>
