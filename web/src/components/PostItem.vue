<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import ArthashPlaceholder from '@/components/ArthashPlaceholder.vue'
import { enableArthash, enableFancyPlaceholder, hideNSFW, selectedPostIdSet, selectingPostIdSet, unselectedPostIdSet } from '@/shared'
import { getPostThumbnailURL, isImageExtension } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'

const props = defineProps<{
  post: PostSimplePublic
}>()
const post = computed(() => props.post)
function onPointerUp(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  // 如果是右键，且没有按 ctrl 或者 shift，点击的是已经选中的文件，则只选中这个文件
  if (e.button === 0 && !e.ctrlKey && !e.shiftKey && selectedPostIdSet.value.has(post.value.id)) {
    // 如果当前节点在 selectingPostIdSet 中，则不操作
    if (selectingPostIdSet.value.has(post.value.id)) {
      return
    }
    selectedPostIdSet.value = new Set([post.value.id])
  }
}

function toggleInSet(target: Set<number | undefined>, id: number) {
  // Clone-then-mutate keeps the watcher chain firing (Vue ref change detection
  // is identity-based for Set), while avoiding the per-element copy that
  // `new Set([...src].filter(...))` does.
  const next = new Set(target)
  if (next.has(id)) {
    next.delete(id)
  }
  else {
    next.add(id)
  }
  return next
}

function addToSet(target: Set<number | undefined>, id: number) {
  if (target.has(id)) {
    return target
  }
  const next = new Set(target)
  next.add(id)
  return next
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  const id = post.value.id
  if (e.shiftKey) {
    if (!selectingPostIdSet.value.has(id) && !selectedPostIdSet.value.has(id)) {
      selectingPostIdSet.value = addToSet(selectingPostIdSet.value, id)
    }
    else {
      unselectedPostIdSet.value = addToSet(unselectedPostIdSet.value, id)
    }
  }
  else if (e.ctrlKey) {
    selectedPostIdSet.value = toggleInSet(selectedPostIdSet.value, id)
  }
  else if (!selectedPostIdSet.value.has(id)) {
    selectedPostIdSet.value = new Set([id])
  }
}
const selected = computed(() => {
  return (selectedPostIdSet.value.has(post.value.id) || selectingPostIdSet.value.has(post.value.id)) && !unselectedPostIdSet.value.has(post.value.id)
})

const isImage = computed(() => isImageExtension(post.value.extension))
const aspectRatio = computed(() => {
  if (isImage.value && post.value.width && post.value.height) {
    return post.value.width / post.value.height
  }
  return 1
})

function getIconByExtension(extension: string) {
  switch (extension) {
    case 'mp3':
    case 'flac':
    case 'wav':
    case 'ogg': {
      return 'i-tabler-music'
    }
    case 'mp4':
    case 'webm':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'wmv':
    case 'flv': {
      return 'i-tabler-video'
    }
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'bz2':
    case 'xz': {
      return 'i-tabler-archive'
    }
    case 'pdf': {
      return 'i-tabler-file-pdf'
    }
    case 'doc':
    case 'docx': {
      return 'i-tabler-file-word'
    }
    case 'xls':
    case 'xlsx': {
      return 'i-tabler-file-excel'
    }
    case 'ppt':
    case 'pptx': {
      return 'i-tabler-file-powerpoint'
    }
    case 'txt': {
      return 'i-tabler-file-text'
    }
    case 'html':
    case 'htm': {
      return 'i-tabler-file-code'
    }
    case 'json': {
      return 'i-tabler-file-code'
    }
    default: {
      return 'i-tabler-file'
    }
  }
}
const imageLoaded = ref(false)
function onImageLoad(e: Event) {
  const img = e.target as HTMLImageElement
  if (img.complete) {
    imageLoaded.value = true
  }
}

const primaryColor = computed(() => {
  if (post.value.colors.length > 0) {
    const dominantColor = post.value.dominantColor
    if (dominantColor) {
      return labToRgbaString(dominantColor[0], dominantColor[1], dominantColor[2])
    }
    return colorNumToHex(post.value.colors.toSorted((a, b) => {
      return a.order - b.order
    })[0].color)
  }
  return 'primary'
})

const placeholderStyle = computed(() => {
  const backgroundColor = primaryColor.value === 'primary' ? '' : primaryColor.value
  return backgroundColor ? { backgroundColor } : {}
})

function onContextmenu(e: MouseEvent) {
  e.preventDefault()
  // if shift key is pressed, select or unselect this post
  selectedPostIdSet.value = e.shiftKey || e.ctrlKey ? new Set([...selectedPostIdSet.value, post.value.id]) : new Set([post.value.id])
}

const router = useRouter()
function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    router.push(`/post/${post.value.id}`)
  }
  else if (e.key === ' ') {
    e.preventDefault()
    selectedPostIdSet.value = e.ctrlKey ? toggleInSet(selectedPostIdSet.value, post.value.id) : new Set([post.value.id])
  }
}
</script>

<template>
  <div
    role="button"
    tabindex="0"
    :aria-pressed="selected"
    :aria-label="`${post.fileName}.${post.extension}`"
    class="post-item flex flex-col gap-1 items-center focus:outline-none"
    :class="{ selected }"
    draggable="true"
    @dragstart.stop
    @pointerdown.stop="onPointerDown"
    @pointerup="onPointerUp"
    @dblclick="$router.push(`/post/${post.id}`)"
    @keydown="onKeyDown"
    @contextmenu.capture="onContextmenu"
  >
    <PAspectRatio
      v-if="isImage"
      :ratio="aspectRatio"
      class="rounded-lg bg-primary w-full"
    >
      <div
        class="post-content rounded-lg relative overflow-hidden"
        :style="placeholderStyle"
      >
        <img
          :src="getPostThumbnailURL(post)"
          :alt="post.fileName"
          :width="post.width ?? undefined"
          :height="post.height ?? undefined"
          class="rounded-lg h-full w-full transition-opacity duration-300 object-cover"
          draggable="true"
          loading="lazy"
          decoding="async"
          :class="{
            'blur': ((post.rating ?? 0) >= 3) && hideNSFW,
            'opacity-0': (!enableArthash || !post.arthash) && !imageLoaded,
          }"
          @load="onImageLoad"
        >
        <ArthashPlaceholder
          v-if="enableArthash && post.arthash"
          :hash="post.arthash"
          :revealed="imageLoaded"
          :fancy="enableFancyPlaceholder"
          class="rounded-lg"
        />
        <div
          v-if="post.matchProb != null"
          class="text-10px text-white tracking-wide font-bold font-mono px-1.5 py-0.5 rounded bg-black/60 pointer-events-none right-1.5 top-1.5 absolute tabular-nums"
        >
          {{ (post.matchProb * 100).toFixed(1) }}%
        </div>
        <div
          v-if="(post.groupMemberCount ?? 0) > 0"
          class="text-10px text-white tracking-wide font-bold font-mono px-1.5 py-0.5 rounded bg-black/60 flex gap-0.5 pointer-events-none items-center bottom-1.5 right-1.5 absolute tabular-nums"
          :title="`同组另有 ${post.groupMemberCount} 张近似图`"
        >
          <i class="i-tabler-stack-2" />+{{ post.groupMemberCount }}
        </div>
      </div>
    </PAspectRatio>
    <PAspectRatio
      v-else
      :ratio="1"
      class="rounded-lg bg-surface-1 w-full"
    >
      <div class="post-content text-fg-muted rounded-lg flex flex-col gap-2 items-center justify-center">
        <i
          aria-hidden="true"
          class="text-5xl"
          :class="getIconByExtension(post.extension)"
        />
        <div class="text-xs tracking-wider font-mono uppercase">
          {{ post.extension }}
        </div>
      </div>
    </PAspectRatio>
    <div class="text-xs text-fg text-center flex flex-col w-full">
      <div class="text-xs w-full truncate">
        <div class="filename-wrapper px-1 rounded inline">
          {{ `${post.fileName}.${post.extension}` }}
        </div>
      </div>
      <div
        v-if="post.width && post.height"
        class="text-11px font-bold font-mono w-full truncate"
      >
        {{ post.width }} x {{ post.height }}
      </div>
    </div>
  </div>
</template>

<style lang="css" scoped>
.post-item {
  transition: transform var(--p-duration-fast) var(--p-ease);
}
.post-content {
  transition:
    outline-color var(--p-duration-fast) var(--p-ease),
    box-shadow var(--p-duration-fast) var(--p-ease);
  outline: 2px solid transparent;
  outline-offset: 2px;
}
.post-item:focus-visible .post-content {
  outline-color: rgb(var(--p-primary-rgb) / 0.7);
}
@media (prefers-reduced-motion: reduce) {
  .post-item,
  .post-content { transition: none; }
}
.selected .post-content {
  outline-color: var(--p-primary);
  box-shadow: 0 0 0 4px rgb(var(--p-primary-rgb) / 0.18);
}
.selected .filename-wrapper {
  background-color: var(--p-primary) !important;
  color: var(--p-on-primary) !important;
}
</style>
