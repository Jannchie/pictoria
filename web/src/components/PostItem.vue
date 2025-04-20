<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { hideNSFW, selectedPostIdSet, selectingPostIdSet, unselectedPostIdSet } from '@/shared'
import { getPostThumbnailURL } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'
import { AspectRatio } from '@roku-ui/vue'
import { computed } from 'vue'

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

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  if (e.shiftKey) {
    if (!selectingPostIdSet.value.has(post.value.id) && !selectedPostIdSet.value.has(post.value.id)) {
      selectingPostIdSet.value = new Set([...selectingPostIdSet.value, post.value.id])
    }
    else {
      unselectedPostIdSet.value = new Set([...unselectedPostIdSet.value, post.value.id])
    }
  }
  else if (e.ctrlKey) {
    if (selectedPostIdSet.value.has(post.value.id)) {
      selectedPostIdSet.value = new Set([...selectedPostIdSet.value].filter(p => p !== post.value.id))
    }
    else {
      selectedPostIdSet.value = new Set([...selectedPostIdSet.value, post.value.id])
    }
  }
  else
    if (!selectedPostIdSet.value.has(post.value.id)) {
      if (!e.ctrlKey) {
        selectedPostIdSet.value = new Set([post.value.id])
      }
      else {
        if (selectedPostIdSet.value.has(post.value.id)) {
          selectedPostIdSet.value = new Set([...selectedPostIdSet.value].filter(p => p !== post.value.id))
        }
        else {
          selectedPostIdSet.value = new Set([...selectedPostIdSet.value, post.value.id])
        }
      }
    }
}
const selected = computed(() => {
  return (selectedPostIdSet.value.has(post.value.id) || selectingPostIdSet.value.has(post.value.id)) && !unselectedPostIdSet.value.has(post.value.id)
})

function getIconByExtension(extension: string) {
  switch (extension) {
    case 'mp3':
    case 'flac':
    case 'wav':
    case 'ogg':
      return 'i-tabler-music'
    case 'mp4':
    case 'webm':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'wmv':
    case 'flv':
      return 'i-tabler-video'
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'bz2':
    case 'xz':
      return 'i-tabler-archive'
    case 'pdf':
      return 'i-tabler-file-pdf'
    case 'doc':
    case 'docx':
      return 'i-tabler-file-word'
    case 'xls':
    case 'xlsx':
      return 'i-tabler-file-excel'
    case 'ppt':
    case 'pptx':
      return 'i-tabler-file-powerpoint'
    case 'txt':
      return 'i-tabler-file-text'
    case 'html':
    case 'htm':
      return 'i-tabler-file-code'
    case 'json':
      return 'i-tabler-file-code'
    default:
      return 'i-tabler-file'
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
    return colorNumToHex([...post.value.colors].sort((a, b) => {
      return a.order - b.order
    })[0].color)
  }
  return 'primary'
})

function onContextmenu(e: MouseEvent) {
  e.preventDefault()
  // if shift key is pressed, select or unselect this post
  if (e.shiftKey || e.ctrlKey) {
    selectedPostIdSet.value = new Set([...selectedPostIdSet.value, post.value.id])
  }
  else {
    selectedPostIdSet.value = new Set([post.value.id])
  }
}
</script>

<template>
  <div
    class="post-item flex flex-col items-center gap-1"
    :class="{ selected }"
    draggable="true"
    @dragstart.stop
    @pointerdown.stop="onPointerDown"
    @pointerup="onPointerUp"
    @dblclick="$router.push(`/post/${post.id}`)"
    @contextmenu.capture="onContextmenu"
  >
    <AspectRatio
      v-if="post.width && post.height"
      :ratio="post.width / post.height"
      class="bg-surface-high w-full rounded-lg bg-primary"
      :style="{ backgroundColor: primaryColor !== 'primary' ? primaryColor : '' }"
    >
      <div class="post-content rounded-lg">
        <Transition
          enter-active-class="transition-opacity duration-300"
          enter-from-class="opacity-0"
          enter-to-class="opacity-100"
        >
          <img
            v-show="imageLoaded"
            :src="getPostThumbnailURL(post)"
            class="w-inherit rounded-lg"
            draggable="true"
            :class="{ blur: ((post.rating ?? 0) >= 3) && hideNSFW }"
            @load="onImageLoad"
          >
        </Transition>
      </div>
    </AspectRatio>
    <AspectRatio
      v-else
      :ratio="1"
      class="post-content h-full w-full rounded-lg bg-surface"
    >
      <div class="p-12">
        <i
          class="h-full w-full"
          :class="getIconByExtension(post.extension)"
        />
      </div>
    </AspectRatio>
    <div class="w-full flex flex-col text-center text-xs text-zinc-4">
      <div class="w-full truncate text-xs">
        <div class="filename-wrapper inline rounded px-1">
          {{ `${post.fileName}.${post.extension}` }}
        </div>
      </div>
      <div
        v-if="post.width && post.height"
        class="w-full truncate text-11px font-bold font-mono"
      >
        {{ post.width }} x {{ post.height }}
      </div>
    </div>
  </div>
</template>

<style lang="css" scoped>
.selected .post-content {
  outline: 4px solid var(--r-primary-background-color) !important;
}
.selected .filename-wrapper {
  background-color: var(--r-primary-background-color) !important;
  color: white !important;
}
</style>
