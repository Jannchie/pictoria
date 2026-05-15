<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { computed, ref } from 'vue'
import { v2DeletePosts } from '@/api'
import {
  currentPostList,
  selectedPostIdSet,
  showPostDetail,
  updateRatingForSelectedPosts,
  updateScoreForSelectedPosts,
} from '@/shared'
import { getPostThumbnailURL } from '@/utils'

const queryClient = useQueryClient()
const numberFormat = new Intl.NumberFormat('en-US')

// Intersect the selected ids with whatever ordered list is currently in view.
// If the user is on a non-gallery route the list may be empty, in which case
// aggregations show zeros — UI degrades gracefully rather than mass-fetching.
const selectedPosts = computed(() => {
  const ids = selectedPostIdSet.value
  return currentPostList.value.filter(p => ids.has(p.id))
})

const count = computed(() => selectedPostIdSet.value.size)
const knownCount = computed(() => selectedPosts.value.length)
const missingCount = computed(() => Math.max(0, count.value - knownCount.value))

const totalSize = computed(() => selectedPosts.value.reduce((sum, p) => sum + (p.size ?? 0), 0))

const RATING_LABELS = ['Unrated', 'G', 'S', 'Q', 'E']
const RATING_COLORS = [
  'var(--p-fg-subtle)',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#ef4444',
]
const ratingDist = computed(() => {
  const buckets = Array.from<number>({ length: 5 }).fill(0)
  for (const p of selectedPosts.value) {
    const r = Math.max(0, Math.min(4, p.rating ?? 0))
    buckets[r] += 1
  }
  return buckets
})

const SCORE_LABELS = ['Unscored', '1', '2', '3', '4', '5']
const SCORE_COLORS = [
  'var(--p-fg-subtle)',
  'rgb(var(--p-primary-rgb) / 0.35)',
  'rgb(var(--p-primary-rgb) / 0.5)',
  'rgb(var(--p-primary-rgb) / 0.65)',
  'rgb(var(--p-primary-rgb) / 0.8)',
  'var(--p-primary)',
]
const scoreDist = computed(() => {
  const buckets = Array.from<number>({ length: 6 }).fill(0)
  for (const p of selectedPosts.value) {
    const s = Math.max(0, Math.min(5, p.score ?? 0))
    buckets[s] += 1
  }
  return buckets
})

const extensionDist = computed(() => {
  const map = new Map<string, number>()
  for (const p of selectedPosts.value) {
    map.set(p.extension, (map.get(p.extension) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
})

const widthRange = computed(() => {
  const values = selectedPosts.value.map(p => p.width).filter(v => v > 0)
  if (values.length === 0) {
    return null
  }
  return { min: Math.min(...values), max: Math.max(...values) }
})
const heightRange = computed(() => {
  const values = selectedPosts.value.map(p => p.height).filter(v => v > 0)
  if (values.length === 0) {
    return null
  }
  return { min: Math.min(...values), max: Math.max(...values) }
})

// Longest common path prefix (segment-wise) across all selected posts.
const commonFolder = computed(() => {
  if (selectedPosts.value.length === 0) {
    return ''
  }
  const paths = selectedPosts.value.map(p => p.filePath.split('/').filter(Boolean))
  if (paths.length === 1) {
    return paths[0].join('/')
  }
  const minLen = Math.min(...paths.map(p => p.length))
  const out: string[] = []
  for (let i = 0; i < minLen; i++) {
    const seg = paths[0][i]
    if (paths.every(p => p[i] === seg)) {
      out.push(seg)
    }
    else {
      break
    }
  }
  return out.join('/')
})

const commonRating = computed<number | null>(() => {
  if (selectedPosts.value.length === 0) {
    return null
  }
  const first = selectedPosts.value[0].rating ?? 0
  return selectedPosts.value.every(p => (p.rating ?? 0) === first) ? first : null
})
const commonScore = computed<number | null>(() => {
  if (selectedPosts.value.length === 0) {
    return null
  }
  const first = selectedPosts.value[0].score ?? 0
  return selectedPosts.value.every(p => (p.score ?? 0) === first) ? first : null
})

const THUMB_LIMIT = 12
const thumbs = computed(() => selectedPosts.value.slice(0, THUMB_LIMIT))
const overflowCount = computed(() => Math.max(0, count.value - thumbs.value.length))

function clearSelection() {
  selectedPostIdSet.value = new Set()
}

function selectAllInList() {
  selectedPostIdSet.value = new Set(currentPostList.value.map(p => p.id))
}

function focusOne(id: number) {
  showPostDetail.value = null
  selectedPostIdSet.value = new Set([id])
}

async function applyRating(rating: number) {
  await updateRatingForSelectedPosts(rating)
  queryClient.invalidateQueries({ queryKey: ['posts'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'rating'] })
  queryClient.invalidateQueries({ queryKey: ['posts', 'stats'] })
}

async function applyScore(score: number) {
  await updateScoreForSelectedPosts(score)
  queryClient.invalidateQueries({ queryKey: ['posts'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  queryClient.invalidateQueries({ queryKey: ['posts', 'stats'] })
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
  const batchSize = 100
  for (let i = 0; i < ids.length; i += batchSize) {
    await v2DeletePosts({ query: { ids: ids.slice(i, i + batchSize) } })
  }
  selectedPostIdSet.value = new Set()
  confirmingDelete.value = false
  queryClient.invalidateQueries({ queryKey: ['posts'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'score'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'rating'] })
  queryClient.invalidateQueries({ queryKey: ['count', 'extension'] })
  queryClient.invalidateQueries({ queryKey: ['posts', 'stats'] })
}

const distributionTotal = computed(() => knownCount.value)

function pct(n: number) {
  if (distributionTotal.value === 0) {
    return 0
  }
  return (n / distributionTotal.value) * 100
}
</script>

<template>
  <ScrollArea
    class="text-xs flex flex-col gap-3 h-full overflow-x-hidden overflow-y-auto"
  >
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between">
        <div class="text-lg text-fg font-semibold tabular-nums">
          {{ numberFormat.format(count) }} <span class="text-sm text-fg-muted font-normal">selected</span>
        </div>
        <div class="flex gap-1">
          <PButton
            icon
            size="sm"
            variant="ghost"
            title="Select all in current list"
            @click="selectAllInList"
          >
            <i class="i-tabler-square-check" />
          </PButton>
          <PButton
            icon
            size="sm"
            variant="ghost"
            title="Clear selection"
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
          :title="`${missingCount} selected post(s) are outside the currently loaded list; stats only cover ${knownCount}.`"
        >
          ({{ numberFormat.format(knownCount) }}/{{ numberFormat.format(count) }} in view)
        </span>
      </div>
    </div>

    <div
      v-if="thumbs.length > 0"
      class="gap-1 grid grid-cols-4"
    >
      <button
        v-for="p of thumbs"
        :key="p.id"
        type="button"
        class="rounded bg-surface-1 aspect-square cursor-pointer transition-all overflow-hidden hover:ring-2 hover:ring-primary"
        :title="`${p.fileName}.${p.extension}`"
        @click="focusOne(p.id)"
      >
        <img
          :src="getPostThumbnailURL(p)"
          class="h-full w-full block object-cover"
        >
      </button>
      <div
        v-if="overflowCount > 0"
        class="text-fg-subtle font-mono rounded bg-surface-1 flex aspect-square items-center justify-center tabular-nums"
      >
        +{{ overflowCount }}
      </div>
    </div>

    <div>
      <div class="text-fg font-semibold py-2">
        Batch
      </div>
      <div class="gap-x-3 gap-y-2 grid grid-cols-[auto_1fr_auto] items-center">
        <div>Rating</div>
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
        >Mixed</span>
        <span v-else />

        <div>Score</div>
        <Rating
          :model-value="commonScore ?? 0"
          :count="5"
          @select="applyScore"
        />
        <span
          v-if="commonScore === null && knownCount > 0"
          class="text-[10px] text-fg-subtle tracking-wide uppercase"
        >Mixed</span>
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
          Copy paths
        </PButton>
      </div>
    </div>

    <div v-if="knownCount > 0">
      <div class="text-fg font-semibold py-2">
        Distribution
      </div>
      <div class="flex flex-col gap-2.5">
        <div class="flex flex-col gap-1">
          <div class="text-fg-subtle flex items-center justify-between">
            <span>Rating</span>
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
            <span>Score</span>
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
    </div>

    <div v-if="knownCount > 0">
      <div class="text-fg font-semibold py-2">
        Files
      </div>
      <div
        class="gap-x-3 gap-y-1.5 grid grid-cols-[auto_1fr] children:break-words odd:children:text-fg-subtle"
      >
        <div>Format</div>
        <div class="flex flex-wrap gap-1">
          <span
            v-for="[ext, n] of extensionDist"
            :key="ext"
            class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-2 uppercase tabular-nums"
          >
            {{ ext }} <span class="text-fg-subtle normal-case">×{{ n }}</span>
          </span>
        </div>
        <div>Width</div>
        <div v-if="widthRange" class="font-mono tabular-nums">
          {{ numberFormat.format(widthRange.min) }} – {{ numberFormat.format(widthRange.max) }} px
        </div>
        <div v-else>
          —
        </div>
        <div>Height</div>
        <div v-if="heightRange" class="font-mono tabular-nums">
          {{ numberFormat.format(heightRange.min) }} – {{ numberFormat.format(heightRange.max) }} px
        </div>
        <div v-else>
          —
        </div>
        <div>Folder</div>
        <div class="text-fg break-all" :title="commonFolder">
          {{ commonFolder || '—' }}
        </div>
      </div>
    </div>

    <div class="mt-auto pt-3">
      <PButton
        size="sm"
        block
        :variant="confirmingDelete ? 'danger' : 'subtle'"
        @click="deleteSelected"
        @blur="confirmingDelete = false"
      >
        <i class="i-tabler-trash" />
        {{ confirmingDelete ? `Click again to delete ${numberFormat.format(count)}` : 'Delete selected' }}
      </PButton>
    </div>
  </ScrollArea>
</template>
