<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import ArthashPlaceholder from '@/components/ArthashPlaceholder.vue'
import { galleryGridKey } from '@/composables/useGalleryGrid'
import { formatDate } from '@/locale'
import { addToSelection, collapseSelectionTo, commitPendingSelection, enableArthash, enableFancyPlaceholder, gridCursorId, hideNSFW, isCommittedSelected, isSelected, postSort, RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, RATING_LEVEL_LABEL_KEYS, RATING_UNRATED_LABEL_KEY, SCORE_LEVEL_COLORS, selectOnly, setGridCursor, toggle, togglePendingAt, waifuLevelRgb } from '@/shared'
import { getPostThumbnailURL, isImageExtension } from '@/utils'
import { colorNumToHex, labToRgbaString } from '@/utils/color'

// A thumbnail is an `option` of the gallery listbox (MainSection /
// SimilarPosts). It is never focusable itself: DOM focus stays on the listbox
// and the keyboard cursor reaches it through aria-activedescendant plus the
// `cursor` ring below (vue-wf unmounts off-screen thumbnails, so a focused
// thumbnail would drop focus to <body>). All keyboard handling lives in
// useGalleryGrid; this component only handles the pointer.
const props = defineProps<{
  post: PostSimplePublic
}>()
const post = computed(() => props.post)
const { t } = useI18n()

const grid = inject(galleryGridKey, null)
watch(() => post.value.id, (id, old) => {
  if (old !== undefined) {
    grid?.unregister(old)
  }
  grid?.register(id)
}, { immediate: true })
onBeforeUnmount(() => grid?.unregister(post.value.id))
const isCursor = computed(() => gridCursorId.value === post.value.id && (grid?.showCursor.value ?? false))

// Accessible name: file name + rating + manual score (the picture alone says
// nothing to a screen reader, and these are what the grid is triaged by).
const accessibleName = computed(() => {
  const p = post.value
  const ratingKey = p.rating >= 1 ? RATING_LEVEL_LABEL_KEYS[p.rating - 1] : undefined
  return t('gallery.optionLabel', {
    name: `${p.fileName}.${p.extension}`,
    rating: ratingKey ? t('gallery.optionRating', { rating: t(ratingKey) }) : t(RATING_UNRATED_LABEL_KEY),
    score: p.score >= 1 ? t('gallery.optionScore', { score: p.score }) : t('common.unscored'),
  })
})
function onPointerUp(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  // 左键、没有 ctrl / shift：若点在已选中项上，则收拢为只选它（拖框刚结束的项除外）。
  if (!e.ctrlKey && !e.shiftKey) {
    collapseSelectionTo(post.value.id)
  }
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) {
    return
  }
  const id = post.value.id
  if (e.shiftKey) {
    togglePendingAt(id)
    // Nothing else commits a shift-click: the drag-box only commits on a real
    // drag, so the toggle used to show as selected yet stay out of the
    // committed selection that batch actions (Delete, 1-5) read.
    commitPendingSelection()
  }
  else if (e.ctrlKey) {
    toggle(id)
  }
  else if (!isCommittedSelected(id)) {
    selectOnly(id)
  }
  // Every click moves the keyboard cursor and range anchor here, so arrows /
  // Shift+arrows continue from the item the mouse last touched.
  setGridCursor(id)
}
const selected = computed(() => isSelected(post.value.id))

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
      return 'i-tabler-file-type-pdf'
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
      return 'i-tabler-file-type-ppt'
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
  if (e.shiftKey || e.ctrlKey) {
    addToSelection(post.value.id)
  }
  else {
    selectOnly(post.value.id)
  }
  setGridCursor(post.value.id)
}

// Top-right value badge: when the gallery is sorted by a value-bearing
// column, the backend echoes each row's sort-column value as `sortValue`;
// show it the same way text search shows its similarity percentage. The
// /recently page forces orderBy=last_accessed_at regardless of postSort
// (mirrors useInfinityPostsQuery), so derive the effective column the same way.
const route = useRoute()
const effectiveSort = computed(() => route.path === '/recently' ? 'last_accessed_at' : postSort.value)
interface SortBadge {
  text?: string
  icon?: string
  color?: string
}
function formatSortValue(v: number | string): SortBadge | undefined {
  switch (effectiveSort.value) {
    case 'score': {
      const n = Number(v)
      return { text: String(v), color: SCORE_LEVEL_COLORS[n - 1] }
    }
    // Rating levels show as their sidebar-selector icon, in the same colour.
    case 'rating': {
      const n = Number(v)
      return n >= 1 && n <= RATING_LEVEL_ICONS.length
        ? { icon: RATING_LEVEL_ICONS[n - 1], color: RATING_LEVEL_COLORS[n - 1] }
        : { text: '—' }
    }
    case 'waifu_score': {
      const n = Number(v)
      return { text: n.toFixed(2), color: `rgb(${waifuLevelRgb(n)})` }
    }
    // The SILVA heads store 0–1; surface them on the same 0–10 scale (and
    // bucket colour ramp) as the detail panel's WaifuScoreLevel chip.
    case 'silva_score':
    case 'silva_luna_score': {
      const n = Number(v) * 10
      return { text: n.toFixed(2), color: `rgb(${waifuLevelRgb(n)})` }
    }
    // |silva − manual| on the 1-5 scale: bigger means model & human disagree
    // more. Flagged amber/red so the worst offenders pop in the grid.
    case 'discrepancy': {
      return { text: Number(v).toFixed(2), color: 'rgb(248 113 113)' }
    }
    case 'created_at':
    case 'published_at':
    case 'updated_at':
    case 'last_accessed_at': {
      return { text: formatDate(v) }
    }
    // file_name is not worth a badge (the grid is pictures, not a listing);
    // id is the "no particular sort" default — no badge for either.
    default: {
      return undefined
    }
  }
}
const sortBadge = computed(() => {
  const v = post.value.sortValue
  return v == null ? undefined : formatSortValue(v)
})
// Tint the badge's dark backing with the level colour too (text colour alone
// is easy to miss); colour-less badges (dates) keep the plain black chip.
const sortBadgeStyle = computed(() => {
  const color = sortBadge.value?.color
  if (!color) {
    return
  }
  return {
    color,
    backgroundColor: `color-mix(in srgb, ${color} 30%, rgb(0 0 0 / 0.78))`,
  }
})
</script>

<template>
  <!-- Nothing but the thumbnail is permanent: the filename lives in the
       aria-label / detail panel, and the dimensions are a hover-only badge on
       the image itself, so a full grid reads as pictures, not as a table of
       labels. -->
  <div
    role="option"
    :aria-selected="selected"
    :aria-label="accessibleName"
    class="post-item group/post"
    :class="{ selected, cursor: isCursor }"
    draggable="true"
    @dragstart.stop
    @pointerdown.stop="onPointerDown"
    @pointerup="onPointerUp"
    @dblclick="$router.push(`/post/${post.id}`)"
    @contextmenu.capture="onContextmenu"
  >
    <PAspectRatio
      v-if="isImage"
      :ratio="aspectRatio"
      class="rounded-md bg-surface-1 w-full"
    >
      <div
        class="post-content rounded-md relative overflow-hidden"
        :style="placeholderStyle"
      >
        <img
          :src="getPostThumbnailURL(post)"
          :alt="post.fileName"
          :width="post.width ?? undefined"
          :height="post.height ?? undefined"
          class="rounded-md h-full w-full transition-opacity duration-300 object-cover"
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
          class="rounded-md"
        />
        <div
          v-if="post.matchProb != null"
          class="p-thumb-badge bg-black/60 right-1.5 top-1.5 absolute"
        >
          {{ (post.matchProb * 100).toFixed(1) }}%
        </div>
        <div
          v-else-if="sortBadge"
          class="p-thumb-badge flex items-center right-1.5 top-1.5 absolute"
          :class="sortBadgeStyle ? undefined : 'bg-black/60'"
          :style="sortBadgeStyle"
        >
          <i
            v-if="sortBadge.icon"
            :class="sortBadge.icon"
            aria-hidden="true"
          />
          <template v-else>
            {{ sortBadge.text }}
          </template>
        </div>
        <div
          v-if="(post.groupMemberCount ?? 0) > 0"
          class="p-thumb-badge bg-black/60 flex gap-0.5 items-center bottom-1.5 right-1.5 absolute"
          :title="$t('post.groupBadgeTitle', { n: post.groupMemberCount }, post.groupMemberCount ?? 0)"
        >
          <i class="i-tabler-stack-2" />+{{ post.groupMemberCount }}
        </div>
        <!-- Dimensions on demand: visible on hover / keyboard focus only. -->
        <div
          v-if="post.width && post.height"
          class="dims-badge p-thumb-badge bg-black/60 opacity-0 transition-opacity bottom-1.5 left-1.5 absolute group-hover/post:opacity-100"
        >
          {{ post.width }}×{{ post.height }}
        </div>
      </div>
    </PAspectRatio>
    <PAspectRatio
      v-else
      :ratio="1"
      class="rounded-md bg-surface-1 w-full"
    >
      <div class="post-content text-fg-subtle rounded-md flex flex-col gap-2 items-center justify-center">
        <i
          aria-hidden="true"
          class="text-4xl"
          :class="getIconByExtension(post.extension)"
        />
        <div class="text-xs tracking-wider font-mono uppercase">
          {{ post.extension }}
        </div>
      </div>
    </PAspectRatio>
  </div>
</template>

<style lang="css" scoped>
.post-content {
  transition: outline-color var(--p-transition-fast);
  outline: 2px solid transparent;
  outline-offset: 2px;
}
/* Hover: a faint outline is enough to say "this one" without competing with
   the selection ring. */
.post-item:hover .post-content {
  outline-color: rgb(var(--p-fg-rgb) / 0.2);
}
/* Selected: the primary ring alone, no halo — a halo on twenty selected
   thumbnails turns the grid into a glow field. */
.selected .post-content,
.selected:hover .post-content {
  outline-color: var(--p-primary);
}
/* Keyboard cursor: a second, outer ring in the foreground colour, so "where
   the keys act" stays distinguishable from "what is selected" (either can be
   on without the other). Only drawn while the grid has keyboard focus. */
.post-item {
  border-radius: var(--p-radius-md);
  outline: 2px solid transparent;
  outline-offset: 5px;
}
.post-item.cursor {
  outline-color: var(--p-fg);
}
.post-item.cursor .dims-badge {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .post-content { transition: none; }
}
</style>
