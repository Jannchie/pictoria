<script setup lang="ts">
import { thumbHashToDataURL } from 'thumbhash'
import { useRoute, useRouter } from 'vue-router'
import PostDetail from '@/components/PostDetail.vue'
import { bottomBarInfo, currentPostList, showPostDetail } from '@/shared'
import { getPostImageURL } from '@/utils'
import { colorNumToHex } from '@/utils/color'

const route = useRoute()
const router = useRouter()
const postId = computed(() => Number.parseInt(route.params.postId as string))
const postQuery = usePostQuery(postId)
const post = computed(() => postQuery.data.value)
const scrollAreaRef = ref<HTMLElement>()
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

const thumbhashDataUrl = computed(() => {
  const hash = post.value?.thumbhash
  if (!hash) {
    return null
  }
  try {
    const bytes = Uint8Array.from(atob(hash), char => char.codePointAt(0) ?? 0)
    return thumbHashToDataURL(bytes)
  }
  catch (error) {
    console.warn(`Failed to decode thumbhash for post ${post.value?.id}:`, error)
    return null
  }
})

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
  if (thumbhashDataUrl.value) {
    style.backgroundImage = `url(${thumbhashDataUrl.value})`
    style.backgroundSize = 'cover'
    style.backgroundPosition = 'center'
    style.backgroundRepeat = 'no-repeat'
  }
  else {
    const color = getPostColor(p)
    if (color !== 'primary') {
      style.backgroundColor = color
    }
  }
  return style
})

function onImageLoad() {
  imageLoaded.value = true
}

watch(postId, () => {
  imageLoaded.value = false
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
    router.push(`/post/${next.id}`)
  }
}

onKeyStroke('Escape', (e) => {
  if (!notUsingInput.value || showPostDetail.value) {
    return
  }
  e.preventDefault()
  router.back()
})

onKeyStroke(['ArrowLeft', 'ArrowRight'], (e) => {
  if (!notUsingInput.value || showPostDetail.value) {
    return
  }
  e.preventDefault()
  navigatePost(e.key === 'ArrowRight' ? 1 : -1)
})

onKeyStroke([' ', 'Enter'], (e) => {
  if (!notUsingInput.value || showPostDetail.value) {
    return
  }
  e.preventDefault()
  openOverlay()
})
</script>

<template>
  <PostDetail
    v-if="showPostDetail"
    :post="showPostDetail"
  />
  <div
    v-if="post"
    class="h-full flex flex-col"
  >
    <div
      class="flex items-center justify-between gap-2 border-b border-border-default bg-bg px-2 py-1"
    >
      <div class="flex flex-1 basis-0 items-center">
        <PButton
          icon
          size="sm"
          variant="ghost"
          @click="$router.back()"
        >
          <i class="i-tabler-arrow-left" />
        </PButton>
      </div>
      <span class="min-w-0 truncate text-sm text-fg font-medium">
        {{ post.fileName }}
      </span>
      <span class="flex-1 basis-0" />
    </div>
    <ScrollArea
      ref="scrollAreaRef"
      class="relative h-full w-full flex flex-grow flex-basis-0 flex-col gap-4"
    >
      <div class="flex justify-center px-2 pt-3">
        <div
          class="relative cursor-pointer overflow-hidden rounded-lg"
          :style="containerStyle"
          @click="showPostDetail = { ...post, width: post.width ?? 0, height: post.height ?? 0 }"
        >
          <Transition
            enter-active-class="transition-opacity duration-300"
            enter-from-class="opacity-0"
            enter-to-class="opacity-100"
          >
            <img
              v-show="imageLoaded"
              :key="post.id"
              ref="imgRef"
              :src="getPostImageURL(post)"
              alt="post"
              class="block h-full w-full object-contain"
              @load="onImageLoad"
            >
          </Transition>
        </div>
      </div>
      <SimilarPosts
        v-if="scrollAreaRef"
        class="w-full"
        :post-id="post.id"
        :scroll-element="scrollAreaRef"
      />
    </ScrollArea>
  </div>
</template>
