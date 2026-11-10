<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import ArthashPlaceholder from '@/components/ArthashPlaceholder.vue'
import ConfirmActionDialog from '@/components/ConfirmActionDialog.vue'
import PostDetail from '@/components/PostDetail.vue'
import { useConfirmAction } from '@/composables/useConfirmAction'
import { useEdgeProximity } from '@/composables/useEdgeProximity'
import { useImageLoadPhase } from '@/composables/useImageLoadPhase'
import { useKeyScope } from '@/composables/useKeyScope'
import { usePostNavAnnounce, usePostNavigation } from '@/composables/usePostNavigation'
import { useAdjacentPostPrefetch } from '@/composables/usePostPrefetch'
import { formatNumber } from '@/locale'
import { announce, bottomBarInfo, clear as clearSelection, currentPostList, deletePosts, enableArthash, enableFancyPlaceholder, isCommittedSelected, lastViewedPostId, postNavContext, selectedIdList, selectOnly, showPostDetail, similarPostList, touchPost } from '@/shared'
import { postFolder, revealPost } from '@/shared/postPaths'
import { shortcuts } from '@/shared/shortcuts'
import { useToast } from '@/shared/toast'
import { useHotkey } from '@/ui/useHotkey'
import { getPostImageURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'
import { focusElement } from '@/utils/focus'
import { allowsViewKeys, isInteractiveTarget } from '@/utils/postViewerKeys'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
// Settled without a post: a 404 surfaces as an error (the client hands back
// no data) — or the id wasn't a number, in which case the query never runs.
const postMissing = computed(() => Number.isNaN(postId.value)
  || (!post.value && (postQuery.isError.value || postQuery.isSuccess.value)))
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
  postNavContext.value = null
})

// 翻页上下文：从相似图点进来的那张不在画廊列表里，←→ 原本就此失灵。记住「上一张图
// 的相似图列表」，新图若是从里面点出来的，就把这张列表（来源图打头）当作翻页列表。
// 必须同步读：等相似图查询换成新图的结果，旧列表就没了。
let lastSimilar: { forId: number, list: PostSimplePublic[] } | null = null
watch(similarPosts, (list) => {
  if (list.length > 0 && Number.isFinite(postId.value)) {
    lastSimilar = { forId: postId.value, list }
  }
}, { immediate: true })
watch(postId, (id, oldId) => {
  if (currentPostList.value.some(p => p.id === id)) {
    postNavContext.value = null
    return
  }
  if (postNavContext.value?.list.some(p => p.id === id)) {
    return // 仍在相似图列表里翻
  }
  const from = lastSimilar && lastSimilar.forId === oldId ? lastSimilar : null
  const current = post.value
  const origin: PostSimplePublic | undefined = from && current?.id === oldId
    ? { ...current, width: current.width ?? 0, height: current.height ?? 0 }
    : undefined
  postNavContext.value = from?.list.some(p => p.id === id)
    ? { kind: 'similar', list: origin ? [origin, ...from.list.filter(p => p.id !== origin.id)] : from.list }
    : null
}, { flush: 'sync' })

// The gallery's context menu ("Find similar") lands here with #similar: bring
// the similar grid to the top of the scroller — once while it is still loading
// (the loader is as far as the page reaches), and once more when the results
// make the page tall enough, then leave the scroll to the user.
let similarScrolledFor: number | null = null
watch([() => route.hash, similarPostsRef, postId, () => similarPosts.value.length], ([hash, similar, id, n]) => {
  if (hash !== '#similar' || !similar || similarScrolledFor === id) {
    return
  }
  if (n > 0) {
    similarScrolledFor = id
  }
  requestAnimationFrame(() => {
    document.querySelector('#similar-posts')?.scrollIntoView({ block: 'start' })
  })
}, { flush: 'post' })
const imgRef = ref<HTMLImageElement>()
// Was a bare `imageLoaded` flag: a failed load kept the <img> at opacity 0 over
// the placeholder for good, which reads as "still loading" forever.
const image = useImageLoadPhase(postId)
const { phase: imagePhase, attempt: imageAttempt, loaded: imageLoaded } = image
// Fallback ratio measured from the decoded image, for posts whose stored
// width/height are 0 (e.g. imported without dimensions). Without it the
// container has no aspect-ratio and the 80vh cap below has nothing to bite on.
const naturalRatio = ref<number | null>(null)

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
  return naturalRatio.value
})

// Longest the image may be on screen, whichever way the ratio is known.
const MAX_IMAGE_HEIGHT = '80vh'

const containerStyle = computed(() => {
  const p = post.value
  if (!p) {
    return {}
  }
  const style: Record<string, string> = {}
  const ratio = imageAspectRatio.value
  if (ratio) {
    style.aspectRatio = String(ratio)
    const widthCaps = ['100%', `calc(${MAX_IMAGE_HEIGHT} * ${ratio})`]
    if (p.width) {
      widthCaps.unshift(`${p.width}px`)
    }
    style.width = `min(${widthCaps.join(', ')})`
  }
  else {
    // Ratio unknown until the image decodes: let the <img> size itself
    // (see imageSizeClass) and only bound it.
    style.width = 'fit-content'
    style.maxWidth = '100%'
    style.maxHeight = MAX_IMAGE_HEIGHT
  }
  const color = getPostColor(p)
  if (color !== 'primary') {
    style.backgroundColor = color
  }
  return style
})

// With a known ratio the container is sized and the image fills it; without
// one the image sizes itself and is capped by the same height limit.
const imageSizeClass = computed(() =>
  imageAspectRatio.value ? 'h-full w-full' : 'h-auto w-auto max-h-[80vh] max-w-full',
)

function onImageLoad() {
  image.onLoad()
  const img = imgRef.value
  if (img && img.naturalWidth && img.naturalHeight) {
    naturalRatio.value = img.naturalWidth / img.naturalHeight
  }
}

watch(postId, (id) => {
  naturalRatio.value = null
  if (Number.isFinite(id)) {
    // 清空选区而不是把主图塞进去：useFocusedPost 在选区为空时会回退到 URL 主图，
    // 侧边栏照样跟随主图（进入页面、键盘 ←→ 切换）。这样用户框选/Ctrl/Shift 点选
    // 相似图时，选区从空开始累积，只含相似图——与列表瀑布流的多选行为完全一致，
    // 不会再有主图残留导致侧边栏出现 “N/M in view” 的差异。
    clearSelection()
    touchPost(id).catch(() => {})
  }
}, { immediate: true })

onMounted(() => {
  image.settleFrom(imgRef.value)
})

watchEffect(() => {
  if (postQuery.data.value) {
    // t() inside watchEffect: a locale switch re-runs this and refreshes
    // the bottom-bar text in the new language.
    bottomBarInfo.value = t('post.bottomInfo', { id: postQuery.data.value.id, name: postQuery.data.value.fileName })
  }
})

// 确认弹窗打开时，页面级快捷键全部让位：Enter/Escape 归 Dialog（确认/
// 取消），否则 Enter 会顺手打开大图、Escape 会退回上一页。侧边栏目录树
// 行获得焦点、或全屏覆盖层打开时同样让位——全部收敛进共享的作用域判定。
const activeKeyScope = useKeyScope()
const onPage = () => activeKeyScope.value === 'postPage'

// 页面根（本页 chrome：返回按钮、翻页竖条都在里面）与主图。
const pageRootRef = ref<HTMLElement | null>(null)
const mainImageRef = ref<HTMLElement | null>(null)
const hintId = useId()

function focusMainImage() {
  focusElement(mainImageRef.value, { preventScroll: true })
}

function openOverlay() {
  const p = post.value
  if (!p) {
    return
  }
  showPostDetail.value = { ...p, width: p.width ?? 0, height: p.height ?? 0 }
}

// 主图舞台（含图两侧的留白），用来判定指针是否贴近它的左右边缘 —— 贴近才浮出
// 翻页竖条。参照物就是竖条所贴的那个盒子，两者边界一致。
const imageStageRef = ref<HTMLElement | null>(null)
const nearEdge = useEdgeProximity(imageStageRef)

const { index, total, list: navList, source: navSource, canPrev, canNext, neighbor } = usePostNavigation(postId)
// Prefetch the neighbours' originals and detail requests (post, group, similar,
// history) so ←→ navigation (page and fullscreen overlay) renders from cache.
useAdjacentPostPrefetch(index, () => navList.value)

/**
 * 返回：有应用内历史就后退；直链 / 刷新进来的（`history.state.back` 为空）后退会
 * 离开应用，改为替换到这张图所在的目录（删掉了这张时不带选中），都不行就回首页。
 */
function goBack(deleted = false) {
  if ((globalThis.history.state as { back?: unknown } | null)?.back != null) {
    router.back()
    return
  }
  const p = post.value
  if (!p) {
    void router.replace('/')
  }
  else if (deleted) {
    void router.replace(`/dir/${postFolder(p)}`)
  }
  else {
    void revealPost(p, postFolder(p), { replace: true })
  }
}
const announceNav = usePostNavAnnounce()

function navigatePost(delta: -1 | 1) {
  const next = neighbor(delta)
  if (next?.id === undefined) {
    return
  }
  const position = index.value + delta + 1
  router.replace(`/post/${next.id}`)
  announceNav(next, position, total.value)
  // 翻到头时那一侧的竖条被 v-if 拿掉，停在它上面的焦点会掉回 <body>；接回主图。
  nextTick(() => {
    const active = document.activeElement
    if (!active || active === document.body || !active.isConnected) {
      focusMainImage()
    }
  })
}

// 离开详情页（返回、侧栏跳目录……）时记下正在看的这张，画廊据此恢复选中和
// 焦点。删掉了当前图再返回时改记它的邻居（见 confirmDelete）。
let returnToId: number | undefined
onBeforeRouteLeave(() => {
  const id = returnToId ?? postId.value
  lastViewedPostId.value = Number.isFinite(id) ? id : null
})

// ←→ / Escape：焦点在控件上时让位（相似图缩略图、评分、滑块……），但本页自己的
// 普通按钮（返回、翻页竖条）放行 —— 点完「下一张」竖条再按 → 应该继续翻。
const viewKeyOptions = {
  when: onPage,
  allowInWidgets: true,
  ignore: (e: KeyboardEvent) => !allowsViewKeys(e.target, pageRootRef.value),
}

useHotkey(shortcuts.postPage.back.keys, () => {
  goBack()
}, viewKeyOptions)

useHotkey(shortcuts.postPage.prevNext.keys, (e) => {
  navigatePost(e.key === 'ArrowRight' ? 1 : -1)
}, viewKeyOptions)

// Enter / 空格看大图：任何按钮、缩略图等控件获得焦点时都让位（它们自己的
// Enter/空格优先），只在主图或页面空白处生效。
useHotkey(shortcuts.postPage.openViewer.keys, openOverlay, {
  when: onPage,
  repeat: false,
  ignore: e => isInteractiveTarget(e.target),
})

// Delete 删除选中的相似图。详情页此前只有列表瀑布流(MainSection)能按 Delete，
// 相似图网格没接，所以这里补上——复用统一的 deletePosts（会刷新 similarPosts 缓存）。
// 选区为空而焦点在主图上时删主图本身（等价于先点主图再按 Delete）。
const queryClient = useQueryClient()
const { pushToast } = useToast()
const deleteConfirm = useConfirmAction<number[]>()

function deleteTargets(e: KeyboardEvent): number[] {
  if (selectedIdList.value.length > 0) {
    return [...selectedIdList.value]
  }
  const main = mainImageRef.value
  if (main && e.target instanceof Node && main.contains(e.target) && Number.isFinite(postId.value)) {
    return [postId.value]
  }
  return []
}

// 控件上也生效（选中相似图后焦点就在缩略图上），只是不抢文本框和目录树（后者
// 有自己的删除目录）。删除进行中对话框不可关闭，request 也只在 closed 时生效，
// 所以不会换掉正在删除的那批 id。
useHotkey(shortcuts.postPage.deleteSelected.keys, (e) => {
  deleteConfirm.request(deleteTargets(e))
}, {
  when: onPage,
  allowInWidgets: true,
  repeat: false,
  ignore: e => deleteTargets(e).length === 0
    || (e.target instanceof Element && e.target.closest('[role=tree]') !== null),
})

// 失败时对话框保持打开（回到 confirming），用户可重试或取消；toast 说明失败。
async function confirmDelete() {
  let removingCurrent = false
  const ok = await deleteConfirm.confirm({
    run: async (ids) => {
      // 选区可能含当前正在看的大图（点了主图）；删掉它后这个详情页就空了，删完返回
      // 上一页。只删相似图时留在原地，列表由 deletePosts 自动刷新。
      removingCurrent = ids.includes(postId.value)
      if (removingCurrent) {
        // 在 deletePosts 把它从列表缓存里拿掉之前先找好邻居，画廊回来时落在它上面。
        returnToId = (neighbor(1) ?? neighbor(-1))?.id
      }
      await deletePosts(queryClient, ids)
      clearSelection()
      announce(t('post.deleted', { n: ids.length }, ids.length))
      if (removingCurrent) {
        goBack(true)
      }
    },
    onError: () => {
      returnToId = undefined
      // 错误 toast 自带 role=alert，不再另行 announce。
      pushToast({ type: 'error', message: t('post.deleteFailed'), duration: 5000, closeable: true })
    },
  })
  if (ok && !removingCurrent) {
    // 被删的缩略图带着焦点一起没了；等对话框自己的焦点归还（微任务）结束后，
    // 焦点若仍无处可去就落回主图。
    setTimeout(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.isConnected) {
        focusMainImage()
      }
    }, 0)
  }
}
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
    :return-focus="() => mainImageRef"
  />
  <!-- 全屏查看器打开时它盖住整页：页面本身 inert，Tab 从查看器直接走到右侧面板，
       不会钻进被盖住的按钮和缩略图。 -->
  <div
    v-if="post"
    ref="pageRootRef"
    class="flex flex-col h-full"
    :inert="showPostDetail != null"
  >
    <div
      class="px-2 py-1 border-b border-border-default bg-bg flex gap-2 items-center justify-between"
    >
      <div class="flex flex-1 basis-0 items-center">
        <PButton
          icon
          size="sm"
          variant="ghost"
          :aria-label="$t('common.back')"
          @click="goBack()"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
        </PButton>
      </div>
      <h1 class="text-sm text-fg font-medium min-w-0 truncate">
        {{ post.fileName }}
      </h1>
      <!-- 在翻哪张列表、翻到第几张：←→ 的作用范围要看得见。 -->
      <div class="text-xs text-fg-muted flex flex-1 basis-0 justify-end">
        <span
          v-if="index !== -1"
          class="whitespace-nowrap tabular-nums"
          :title="navSource === 'similar' ? $t('post.navSimilarTitle') : $t('post.navGalleryTitle')"
        >
          <template v-if="navSource === 'similar'">{{ $t('post.navSimilar') }} · </template>{{ formatNumber(index + 1) }} / {{ formatNumber(total) }}
        </span>
        <span v-else class="text-fg-subtle whitespace-nowrap" :title="$t('post.navNotInListTitle')">
          {{ $t('post.navNotInList') }}
        </span>
      </div>
    </div>
    <PScrollArea
      ref="scrollAreaRef"
      class="flex flex-grow flex-basis-0 flex-col h-full w-full relative"
    >
      <!-- No flex gap here: PSelectArea renders an empty 0-height box, and a
           gap would count it as an item — a blank band above the image. The
           spacing below matches the image's 8px side gutter instead. -->
      <PSelectArea
        :target="scrollAreaRef"
        @select-change="onSelectChange"
        @select-end="onSelectEnd"
      />
      <div class="pt-2">
        <!-- 舞台的高度就是图片的高度（上边距提到外层），所以贴着它上下拉满的
             翻页竖条正好与画面平齐，同时落在图两侧的留白里而不压住画面。 -->
        <div ref="imageStageRef" class="px-2 flex justify-center relative">
          <!-- 上一张 / 下一张。和 ←→ 走同一个 navigatePost,只是给鼠标一个入口。
               平时透明,指针贴近那一侧才浮出来。 -->
          <PEdgeNavRail
            v-if="canPrev"
            side="left"
            :shown="nearEdge === 'left'"
            :label="$t('post.previous')"
            aria-keyshortcuts="ArrowLeft"
            @click="navigatePost(-1)"
          />
          <PEdgeNavRail
            v-if="canNext"
            side="right"
            :shown="nearEdge === 'right'"
            :label="$t('post.next')"
            aria-keyshortcuts="ArrowRight"
            @click="navigatePost(1)"
          />
          <!-- 主图可聚焦但不是控件（role=img）：焦点在它上面时页面热键照常生效 ——
               Enter/空格看大图、Delete 删它、←→ 翻页。 -->
          <div
            ref="mainImageRef"
            tabindex="0"
            role="img"
            :aria-label="post.fileName"
            :aria-describedby="hintId"
            aria-keyshortcuts="Enter Space"
            class="main-post-image rounded-lg cursor-pointer relative overflow-hidden"
            :class="{ 'main-post-selected': isCommittedSelected(postId) }"
            :style="containerStyle"
            @click="selectOnly(postId)"
            @dblclick="openOverlay"
          >
            <img
              :key="`${post.id}:${imageAttempt}`"
              ref="imgRef"
              :src="getPostImageURL(post)"
              alt=""
              :width="post.width ?? undefined"
              :height="post.height ?? undefined"
              fetchpriority="high"
              decoding="async"
              class="block transition-opacity duration-300 object-contain"
              :class="[imageSizeClass, { 'opacity-0': (!enableArthash || !post.arthash) && !imageLoaded }]"
              @load="onImageLoad"
              @error="image.onError"
            >
            <ArthashPlaceholder
              v-if="enableArthash && post.arthash"
              :hash="post.arthash"
              :revealed="imageLoaded"
              :fancy="enableFancyPlaceholder"
            />
            <div
              v-if="imagePhase === 'failed'"
              role="alert"
              class="text-sm text-fg-muted p-4 text-center bg-surface-1 flex flex-col gap-2 items-center justify-center"
              :class="imageAspectRatio ? 'absolute inset-0' : 'min-h-48 min-w-64'"
            >
              <i class="i-tabler-photo-off text-fg-subtle h-6 w-6" aria-hidden="true" />
              <span>{{ $t('post.imageLoadFailed') }}</span>
              <PButton size="sm" @click.stop="image.retry" @dblclick.stop>
                {{ $t('common.retry') }}
              </PButton>
            </div>
          </div>
          <p :id="hintId" class="sr-only">
            {{ $t('post.mainImageHint') }}
          </p>
        </div>
      </div>
      <!-- Scroll target for /post/:id#similar (zero-height: SimilarPosts has
           several roots, so it can't carry the id itself). -->
      <div id="similar-posts" class="scroll-mt-2" aria-hidden="true" />
      <SimilarPosts
        v-if="scrollAreaRef"
        ref="similarPostsRef"
        class="mt-2 w-full"
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </PScrollArea>
  </div>
  <!-- A deleted post (or a mistyped id) used to leave the pane blank. -->
  <div
    v-else-if="postMissing"
    class="flex h-full items-center justify-center"
  >
    <PEmpty icon="i-tabler-photo-off">
      {{ $t('post.notFound') }}
      <template #action>
        <PButton
          size="sm"
          variant="secondary"
          class="mt-2"
          @click="$router.push('/')"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
          {{ $t('common.backToGallery') }}
        </PButton>
      </template>
    </PEmpty>
  </div>
  <ConfirmActionDialog
    v-slot="{ target: ids }"
    :action="deleteConfirm"
    :title="$t('post.deleteDialogTitle')"
    :confirm-label="ids => $t('post.deleteDialogConfirm', { n: ids.length })"
    :busy-label="$t('post.deleteDialogDeleting')"
    @confirm="confirmDelete"
  >
    <i18n-t keypath="post.deleteDialogBody" tag="p" scope="global" :plural="ids.length">
      <template #n>
        <span class="text-fg font-medium tabular-nums">{{ ids.length }}</span>
      </template>
    </i18n-t>
  </ConfirmActionDialog>
</template>

<style lang="css" scoped>
.main-post-image {
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition:
    outline-color var(--p-transition-fast),
    box-shadow var(--p-transition-fast);
}
/* 上面那条透明 outline 的特异性盖过了全局 :focus-visible，这里把焦点环接回来。 */
.main-post-image:focus-visible {
  outline: var(--p-focus-ring);
  outline-offset: 2px;
}
.main-post-selected {
  outline-color: var(--p-primary);
  box-shadow: 0 0 0 4px rgb(var(--p-primary-rgb) / 0.18);
}
</style>
