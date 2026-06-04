<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useSelectedPostStats } from '@/composables/useSelectedPostStats'
import { formatNumber } from '@/locale'
import {
  commitRating,
  commitScore,
  currentPostList,
  deletePosts,
  selectedPostIdSet,
  showPostDetail,
  similarPostList,
} from '@/shared'
import { getPostThumbnailURL } from '@/utils'

const { t } = useI18n()
const queryClient = useQueryClient()
const route = useRoute()

// The ordered list currently in view: the similar-posts grid on a post detail
// page, otherwise the gallery list. Keeping these separate (rather than reusing
// currentPostList everywhere) lets the detail page's prev/next arrow nav stay
// on the gallery while the panel here reflects the similar grid the user sees.
const visibleList = computed(() =>
  route.name === 'post' ? similarPostList.value : currentPostList.value,
)

// Intersect the selected ids with whatever ordered list is currently in view.
// If the user is on a non-gallery route the list may be empty, in which case
// aggregations show zeros — UI degrades gracefully rather than mass-fetching.
const selectedPosts = computed(() => {
  const ids = selectedPostIdSet.value
  return visibleList.value.filter(p => ids.has(p.id))
})

const count = computed(() => selectedPostIdSet.value.size)
const knownCount = computed(() => selectedPosts.value.length)
const missingCount = computed(() => Math.max(0, count.value - knownCount.value))

const {
  totalSize,
  ratingDist,
  scoreDist,
  extensionDist,
  widthRange,
  heightRange,
  commonFolder,
  commonRating,
  commonScore,
} = useSelectedPostStats(selectedPosts)

const RATING_LABELS = computed(() => [t('rating.unrated'), 'G', 'S', 'Q', 'E'])
const RATING_COLORS = [
  'var(--p-fg-subtle)',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
]
const SCORE_LABELS = computed(() => [t('common.unscored'), '1', '2', '3', '4', '5'])
// Quality ramp: low score = red, high score = green (0 = unscored, muted).
// Mirrors RATING_COLORS' hard-coded hex so both distribution bars read alike.
const SCORE_COLORS = [
  'var(--p-fg-subtle)',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#22c55e',
]

const THUMB_LIMIT = 12
const thumbs = computed(() => selectedPosts.value.slice(0, THUMB_LIMIT))
const overflowCount = computed(() => Math.max(0, count.value - thumbs.value.length))

// Stable pseudo-random in [0,1) seeded by id+idx — keeps the messy-pile layout
// from re-shuffling on every render.
function hash01(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43_758.5453
  return x - Math.floor(x)
}
const THUMB_LONG_EDGE = 88
const Z_LEVELS = 13
function thumbZ(idx: number): number {
  return (idx * 7) % Z_LEVELS // 0 = bottom layer, 12 = top layer ("background")
}

function thumbStyle(p: PostSimplePublic, idx: number) {
  const ratio = p.aspectRatio || (p.width && p.height ? p.width / p.height : 1)
  const width = ratio >= 1 ? THUMB_LONG_EDGE : THUMB_LONG_EDGE * ratio
  const height = ratio >= 1 ? THUMB_LONG_EDGE / ratio : THUMB_LONG_EDGE
  const rot = (hash01(p.id + idx * 7) - 0.5) * 28
  const dx = (hash01(p.id * 13 + idx) - 0.5) * 60
  const dy = (hash01(p.id * 29 + idx * 3) - 0.5) * 40
  return {
    width: `${width.toFixed(1)}px`,
    height: `${height.toFixed(1)}px`,
    transform: `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(2)}deg)`,
    zIndex: thumbZ(idx),
  }
}

// Per-thumb timing — driven by z-layer, NOT by v-for position. The top
// ("background", visually dominant) layer enters last & leaves first; buried
// layers enter first & linger. Worst-case total stays ≤ 1s regardless of N.
function thumbTiming(id: number, idx: number) {
  const z = thumbZ(idx)
  const layer = z / (Z_LEVELS - 1)
  return {
    enterDelay: layer * 420 + hash01(id * 41 + idx * 5) * 80,
    leaveDelay: (1 - layer) * 420 + hash01(id * 67 + idx * 9) * 80,
    duration: 220 + hash01(id * 53 + idx * 11) * 80,
  }
}

// Self-managed display list — bypasses Vue's TransitionGroup entirely so we
// can drive per-thumb opacity with setTimeout + CSS transition, in strict
// z-layer order rather than v-for/DOM-insertion order.
interface DisplayedThumb {
  id: number
  post: PostSimplePublic
  idx: number
  opacity: number
  duration: number
}
const displayedThumbs = ref<DisplayedThumb[]>([])
const thumbTimers = new Map<number, ReturnType<typeof setTimeout>[]>()

function pushThumbTimer(id: number, fn: () => void, ms: number) {
  const t = setTimeout(fn, ms)
  let arr = thumbTimers.get(id)
  if (!arr) {
    arr = []
    thumbTimers.set(id, arr)
  }
  arr.push(t)
}
function clearThumbTimers(id: number) {
  const timers = thumbTimers.get(id)
  if (timers) {
    for (const t of timers) {
      clearTimeout(t)
    }
  }
  thumbTimers.delete(id)
}
// Schedule a transition target — wraps the final assignment in rAF so the
// browser is guaranteed to paint the previous opacity once before the new
// value is applied, otherwise Vue may batch the 0 → 1 flip into one frame
// and the transition is silently dropped.
function scheduleOpacity(item: DisplayedThumb, target: number, delayMs: number) {
  pushThumbTimer(item.id, () => {
    requestAnimationFrame(() => {
      item.opacity = target
    })
  }, delayMs)
}

watch(
  thumbs,
  (next) => {
    const nextIds = new Set(next.map(p => p.id))
    const idxOf = new Map(next.map((p, i) => [p.id, i]))

    // Incoming / refreshed: fade to 1 after enterDelay
    for (const [idx, p] of next.entries()) {
      const existing = displayedThumbs.value.find(d => d.id === p.id)
      const timing = thumbTiming(p.id, idx)
      if (existing) {
        existing.idx = idx
        existing.post = p
        if (existing.opacity === 0) {
          clearThumbTimers(p.id)
          existing.duration = timing.duration
          scheduleOpacity(existing, 1, timing.enterDelay)
        }
      }
      else {
        const item: DisplayedThumb = {
          id: p.id,
          post: p,
          idx,
          opacity: 0,
          duration: timing.duration,
        }
        displayedThumbs.value.push(item)
        scheduleOpacity(item, 1, timing.enterDelay)
      }
    }

    // Outgoing: fade to 0 after leaveDelay, remove when transition completes
    ;for (const d of displayedThumbs.value) {
      if (!nextIds.has(d.id) && d.opacity !== 0) {
        clearThumbTimers(d.id)
        const timing = thumbTiming(d.id, idxOf.get(d.id) ?? d.idx)
        d.duration = timing.duration
        scheduleOpacity(d, 0, timing.leaveDelay)
        pushThumbTimer(d.id, () => {
          const i = displayedThumbs.value.findIndex(x => x.id === d.id)
          if (i !== -1) {
            displayedThumbs.value.splice(i, 1)
          }
          clearThumbTimers(d.id)
        }, timing.leaveDelay + timing.duration + 40)
      }
    }
  },
  { immediate: true },
)

onUnmounted(() => {
  for (const arr of thumbTimers.values()) {
    for (const t of arr) {
      clearTimeout(t)
    }
  }
  thumbTimers.clear()
})

function clearSelection() {
  selectedPostIdSet.value = new Set()
}

function selectAllInList() {
  selectedPostIdSet.value = new Set(visibleList.value.map(p => p.id))
}

function focusOne(id: number) {
  showPostDetail.value = null
  selectedPostIdSet.value = new Set([id])
}

async function applyRating(rating: number) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  await commitRating(queryClient, selectedPosts.value, ids, rating)
}

async function applyScore(score: number) {
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  await commitScore(queryClient, selectedPosts.value, ids, score)
}

async function copyPaths() {
  const text = selectedPosts.value
    .map(p => `${p.filePath}/${p.fileName}.${p.extension}`)
    .join('\n')
  if (text) {
    await navigator.clipboard.writeText(text).catch(() => {})
  }
}

// Two-stage delete: first click arms the button, second confirms.
const confirmingDelete = ref(false)
async function deleteSelected() {
  if (!confirmingDelete.value) {
    confirmingDelete.value = true
    return
  }
  const ids = [...selectedPostIdSet.value].filter((id): id is number => typeof id === 'number')
  if (ids.length === 0) {
    confirmingDelete.value = false
    return
  }
  await deletePosts(queryClient, ids)
  selectedPostIdSet.value = new Set()
  confirmingDelete.value = false
}

const distributionTotal = computed(() => knownCount.value)

function pct(n: number) {
  if (distributionTotal.value === 0) {
    return 0
  }
  return (n / distributionTotal.value) * 100
}

// Section heading style, kept in sync with PostDetailPanel.vue so both side
// panels share one editorial rhythm: small uppercase label with a leading icon.
const sectionTitleClass
  = 'flex items-center gap-1.5 text-fg-subtle text-[11px] font-semibold uppercase tracking-wider'
</script>

<template>
  <ScrollArea
    class="text-xs flex flex-col h-full overflow-x-hidden overflow-y-auto"
  >
    <div class="pb-3 pt-1 flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <div class="text-lg text-fg font-semibold tabular-nums">
          {{ formatNumber(count) }} <span class="text-sm text-fg-muted font-normal">{{ $t('multiSelect.selected') }}</span>
        </div>
        <div class="flex gap-1">
          <PButton
            icon
            size="sm"
            variant="ghost"
            :title="$t('multiSelect.selectAll')"
            @click="selectAllInList"
          >
            <i class="i-tabler-square-check" />
          </PButton>
          <PButton
            icon
            size="sm"
            variant="ghost"
            :title="$t('multiSelect.clearSelection')"
            @click="clearSelection"
          >
            <i class="i-tabler-x" />
          </PButton>
        </div>
      </div>
      <div class="text-fg-subtle flex flex-wrap gap-x-2 gap-y-0.5 items-center">
        <span v-if="totalSize > 0" class="font-mono tabular-nums">
          {{ filesize(totalSize) }}
        </span>
        <span v-if="totalSize > 0 && extensionDist.length > 0" class="op50">·</span>
        <span v-if="extensionDist.length > 0" class="font-mono">
          {{ extensionDist.map(([e]) => e).join(', ') }}
        </span>
        <span
          v-if="missingCount > 0"
          class="text-[10px] text-fg-subtle ml-auto"
          :title="$t('multiSelect.outsideNote', { missing: missingCount, known: knownCount }, missingCount)"
        >
          {{ $t('multiSelect.inView', { known: formatNumber(knownCount), total: formatNumber(count) }) }}
        </span>
      </div>
    </div>

    <div
      v-if="displayedThumbs.length > 0"
      class="flex shrink-0 h-50 w-full select-none items-center justify-center relative"
    >
      <button
        v-for="d of displayedThumbs"
        :key="d.id"
        type="button"
        class="rounded bg-white cursor-pointer ring-1 ring-black/10 shadow-md left-1/2 top-1/2 absolute overflow-hidden hover:ring-2 hover:ring-primary hover:shadow-xl"
        :style="{
          ...thumbStyle(d.post, d.idx),
          opacity: d.opacity,
          transition: `opacity ${d.duration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }"
        :title="`${d.post.fileName}.${d.post.extension}`"
        @click="focusOne(d.id)"
      >
        <img
          :src="getPostThumbnailURL(d.post)"
          class="h-full w-full block object-cover"
          draggable="false"
        >
      </button>
      <div
        v-if="overflowCount > 0"
        class="text-sm text-fg tracking-tight font-mono font-semibold px-2.5 py-1 rounded-full bg-surface-2/90 pointer-events-none ring-1 ring-border-default shadow-lg left-1/2 top-1/2 absolute backdrop-blur tabular-nums -translate-x-1/2 -translate-y-1/2"
        style="z-index: 20"
      >
        +{{ overflowCount }}
      </div>
    </div>

    <section class="py-4 border-t border-border-default">
      <div
        :class="sectionTitleClass"
        class="mb-2"
      >
        <i class="i-tabler-edit" />
        <span>{{ $t('multiSelect.batch') }}</span>
      </div>
      <div class="gap-x-3 gap-y-2 grid grid-cols-[auto_1fr_auto] items-center">
        <div>{{ $t('post.ratingLabel') }}</div>
        <Rating
          :model-value="commonRating ?? 0"
          highlight-selected-only
          :count="4"
          :colors="['green', 'yellow', 'orange', 'red']"
          :icons="['i-tabler-seeding', 'i-tabler-mood-heart', 'i-tabler-eye-off', 'i-tabler-eyeglass-off']"
          @select="applyRating"
        />
        <span
          v-if="commonRating === null && knownCount > 0"
          class="text-[10px] text-fg-subtle tracking-wide uppercase"
        >{{ $t('common.mixed') }}</span>
        <span v-else />

        <div>{{ $t('post.scoreLabel') }}</div>
        <Rating
          :model-value="commonScore ?? 0"
          :count="5"
          @select="applyScore"
        />
        <span
          v-if="commonScore === null && knownCount > 0"
          class="text-[10px] text-fg-subtle tracking-wide uppercase"
        >{{ $t('common.mixed') }}</span>
        <span v-else />
      </div>
      <div class="mt-3">
        <PButton
          size="sm"
          variant="subtle"
          block
          @click="copyPaths"
        >
          <i class="i-tabler-copy" />
          {{ $t('multiSelect.copyPaths') }}
        </PButton>
      </div>
    </section>

    <section
      v-if="knownCount > 0"
      class="py-4 border-t border-border-default"
    >
      <div
        :class="sectionTitleClass"
        class="mb-2"
      >
        <i class="i-tabler-chart-bar" />
        <span>{{ $t('multiSelect.distribution') }}</span>
      </div>
      <div class="flex flex-col gap-2.5">
        <div class="flex flex-col gap-1">
          <div class="text-fg-subtle flex items-center justify-between">
            <span>{{ $t('post.ratingLabel') }}</span>
            <span class="text-[10px] text-fg-subtle font-mono">— · G · S · Q · E</span>
          </div>
          <div class="rounded bg-surface-1 flex h-2 overflow-hidden">
            <div
              v-for="(n, i) of ratingDist"
              :key="i"
              :style="{ width: `${pct(n)}%`, backgroundColor: RATING_COLORS[i] }"
              :title="`${RATING_LABELS[i]}: ${n}`"
            />
          </div>
        </div>
        <div class="flex flex-col gap-1">
          <div class="text-fg-subtle flex items-center justify-between">
            <span>{{ $t('post.scoreLabel') }}</span>
            <span class="text-[10px] text-fg-subtle font-mono">— · 1 · 2 · 3 · 4 · 5</span>
          </div>
          <div class="rounded bg-surface-1 flex h-2 overflow-hidden">
            <div
              v-for="(n, i) of scoreDist"
              :key="i"
              :style="{ width: `${pct(n)}%`, backgroundColor: SCORE_COLORS[i] }"
              :title="`${SCORE_LABELS[i]}: ${n}`"
            />
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="knownCount > 0"
      class="py-4 border-t border-border-default"
    >
      <div
        :class="sectionTitleClass"
        class="mb-2"
      >
        <i class="i-tabler-files" />
        <span>{{ $t('multiSelect.files') }}</span>
      </div>
      <div
        class="gap-x-3 gap-y-1.5 grid grid-cols-[auto_1fr] children:break-words odd:children:text-fg-subtle"
      >
        <div>{{ $t('multiSelect.format') }}</div>
        <div class="flex flex-wrap gap-1">
          <span
            v-for="[ext, n] of extensionDist"
            :key="ext"
            class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-2 uppercase tabular-nums"
          >
            {{ ext }} <span class="text-fg-subtle normal-case">×{{ n }}</span>
          </span>
        </div>
        <div>{{ $t('multiSelect.width') }}</div>
        <div v-if="widthRange" class="font-mono tabular-nums">
          {{ formatNumber(widthRange.min) }} – {{ formatNumber(widthRange.max) }} px
        </div>
        <div v-else>
          —
        </div>
        <div>{{ $t('multiSelect.height') }}</div>
        <div v-if="heightRange" class="font-mono tabular-nums">
          {{ formatNumber(heightRange.min) }} – {{ formatNumber(heightRange.max) }} px
        </div>
        <div v-else>
          —
        </div>
        <div>{{ $t('multiSelect.folder') }}</div>
        <div class="text-fg break-all" :title="commonFolder">
          {{ commonFolder || '—' }}
        </div>
      </div>
    </section>

    <div class="mt-auto pt-4 border-t border-border-default">
      <PButton
        size="sm"
        block
        :variant="confirmingDelete ? 'danger' : 'subtle'"
        @click="deleteSelected"
        @blur="confirmingDelete = false"
      >
        <i class="i-tabler-trash" />
        {{ confirmingDelete ? $t('multiSelect.deleteConfirm', { n: formatNumber(count) }) : $t('multiSelect.deleteSelected') }}
      </PButton>
    </div>
  </ScrollArea>
</template>
