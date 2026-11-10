<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { filesize } from 'filesize'
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAPIError } from '@/composables/useAPIError'
import { useConfirmAction } from '@/composables/useConfirmAction'
import { focusGalleryGrid } from '@/composables/useGalleryGrid'
import { useSelectedPostStats } from '@/composables/useSelectedPostStats'
import { useThumbPile } from '@/composables/useThumbPile'
import { formatNumber } from '@/locale'
import {
  announce,
  clear,
  commitRating,
  commitScore,
  deletePosts,
  groupPostsTogether,
  isCommittedSelected,
  RATING_LEVEL_COLORS,
  RATING_LEVEL_ICONS,
  RATING_LEVEL_SHORT_KEYS,
  ratingLevelNames,
  ratingName,
  SCORE_LEVEL_COLORS,
  selectAll,
  selectedCount,
  selectedIdList,
  selectOnly,
  setGridCursor,
  showPostDetail,
} from '@/shared'
import { copyPostPaths } from '@/shared/postPaths'
import { useToast } from '@/shared/toast'
import { visiblePostList } from '@/shared/visiblePosts'
import { getPostThumbnailURL } from '@/utils'

const { t } = useI18n()
const queryClient = useQueryClient()
const { pushToast } = useToast()
const { handle: handleAPIError } = useAPIError()

// Intersect the selected ids with whatever ordered list is currently in view.
// If the user is on a non-gallery route the list may be empty, in which case
// aggregations show zeros — UI degrades gracefully rather than mass-fetching.
const selectedPosts = computed(() => {
  return visiblePostList.value.filter(p => isCommittedSelected(p.id))
})

const count = selectedCount
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

const RATING_SHORT = computed(() => RATING_LEVEL_SHORT_KEYS.map(k => t(k)))
const RATING_LABELS = computed(() => [ratingName(0, t), ...RATING_SHORT.value])
// Full names: the rating control's option names, and the screen-reader
// rendering of the distribution bars.
const RATING_LEVEL_NAMES = computed(() => ratingLevelNames(t))
const RATING_FULL_LABELS = computed(() => [ratingName(0, t), ...RATING_LEVEL_NAMES.value])
// Visual legend under the bar heading: "—" stands for the unrated/unscored bucket.
const RATING_LEGEND = computed(() => ['—', ...RATING_SHORT.value].join(' · '))
const SCORE_LEGEND = ['—', '1', '2', '3', '4', '5'].join(' · ')
const RATING_COLORS = ['var(--p-fg-subtle)', ...RATING_LEVEL_COLORS]
const SCORE_LABELS = computed(() => [t('common.unscored'), '1', '2', '3', '4', '5'])
// Quality ramp: low score = red, high score = green (0 = unscored, muted).
const SCORE_COLORS = ['var(--p-fg-subtle)', ...SCORE_LEVEL_COLORS]

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
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const Z_LEVELS = 13
function thumbZ(idx: number): number {
  return (idx * 7) % Z_LEVELS // 0 = bottom layer, 12 = top layer ("background")
}

function thumbStyle(p: PostSimplePublic, idx: number) {
  const ratio = p.aspectRatio || (p.width && p.height ? p.width / p.height : 1)
  const width = ratio >= 1 ? THUMB_LONG_EDGE : THUMB_LONG_EDGE * ratio
  const height = ratio >= 1 ? THUMB_LONG_EDGE / ratio : THUMB_LONG_EDGE
  // Placement by pile position (a golden-angle spiral: every index gets its own
  // spot) plus a little id-seeded jitter. Purely random offsets could land two
  // cards on the same spot — with three selected, one was hidden outright.
  const radius = idx === 0 ? 0 : 22 + 7 * Math.sqrt(idx)
  const angle = idx * GOLDEN_ANGLE
  const rot = (hash01(p.id + idx * 7) - 0.5) * 24
  const dx = radius * Math.cos(angle) * 1.4 + (hash01(p.id * 13 + idx) - 0.5) * 8
  const dy = radius * Math.sin(angle) + (hash01(p.id * 29 + idx * 3) - 0.5) * 6
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

// Self-managed display list with per-thumb lifecycle (entering | shown |
// leaving) — see useThumbPile.
const displayedThumbs = useThumbPile(thumbs, thumbTiming)

// The actions below empty or shrink the selection, so this panel is swapped
// for another one while its button still holds focus. Send focus to the grid
// (the cursor item) instead of letting it fall to <body>.
function clearSelection() {
  clear()
  focusGalleryGrid()
}

function selectAllInList() {
  selectAll(visiblePostList.value.map(p => p.id))
}

function focusOne(id: number) {
  showPostDetail.value = null
  selectOnly(id)
  setGridCursor(id)
  focusGalleryGrid()
}

async function applyRating(rating: number) {
  await commitRating(queryClient, selectedPosts.value, selectedIdList.value, rating)
}

async function applyScore(score: number) {
  await commitScore(queryClient, selectedPosts.value, selectedIdList.value, score)
}

function copyPaths() {
  return copyPostPaths(selectedPosts.value)
}

// Merge the whole selection into one near-duplicate group. The selection can
// reach past the loaded list (selectedIdList, not selectedPosts) — the server
// resolves the representative, so the panel does not need the rows.
const isGrouping = ref(false)
async function groupSelected() {
  const ids = selectedIdList.value
  if (isGrouping.value || ids.length < 2) {
    return
  }
  isGrouping.value = true
  try {
    await groupPostsTogether(queryClient, ids)
    pushToast({
      type: 'success',
      message: t('multiSelect.groupSelectedDone', { n: formatNumber(ids.length) }, ids.length),
      duration: 3000,
    })
  }
  catch (error) {
    handleAPIError(error)
  }
  finally {
    isGrouping.value = false
  }
}

// Two-stage delete: first click arms the button (snapshotting the selected
// ids), second confirms. While the request is in flight the button is loading
// (PButton swallows clicks) and `request` / `cancel` are no-ops, so a third
// click cannot send the same ids again; blur only disarms. A failed delete
// stays armed so the user can retry, like the dialog-based delete flows.
const deleteConfirm = useConfirmAction<number[]>()
const { target: deleteTarget, isRunning: isDeleting } = deleteConfirm
function deleteSelected() {
  if (deleteTarget.value === null) {
    const ids = selectedIdList.value
    if (ids.length === 0) {
      return
    }
    deleteConfirm.request(ids)
    // The button's label changes under focus; not every screen reader
    // re-reads it, so say the new state.
    announce(t('multiSelect.deleteConfirm', { n: formatNumber(ids.length) }))
    return
  }
  return deleteConfirm.confirm({
    run: async (ids) => {
      await deletePosts(queryClient, ids)
      clear()
      focusGalleryGrid()
    },
    onError: error => handleAPIError(error),
  })
}

const uid = useId()
const ratingLabelId = `${uid}-rating`
const scoreLabelId = `${uid}-score`
const thumbsLabelId = `${uid}-thumbs`

const distributionTotal = computed(() => knownCount.value)

function pct(n: number) {
  if (distributionTotal.value === 0) {
    return 0
  }
  return (n / distributionTotal.value) * 100
}
</script>

<template>
  <PScrollArea
    class="text-xs h-full overflow-x-hidden overflow-y-auto"
  >
    <!-- px-3: the pane has no padding of its own, the scrolled content owns
         the 12px gutter. min-h-full keeps mt-auto pinning the delete button
         to the bottom when the content is shorter than the pane. -->
    <div class="px-3 flex flex-col min-h-full">
      <div class="pb-3 pt-3 p-divider flex flex-col gap-1">
        <div class="flex items-center justify-between">
          <div class="text-lg text-fg font-semibold tabular-nums">
            {{ formatNumber(count) }} <span class="text-sm text-fg-muted font-normal">{{ $t('multiSelect.selected') }}</span>
          </div>
          <div class="flex gap-1">
            <PButton
              icon
              size="sm"
              variant="ghost"
              :aria-label="$t('multiSelect.selectAll')"
              :title="$t('multiSelect.selectAll')"
              @click="selectAllInList"
            >
              <i class="i-tabler-square-check" aria-hidden="true" />
            </PButton>
            <PButton
              icon
              size="sm"
              variant="ghost"
              :aria-label="$t('multiSelect.clearSelection')"
              :title="$t('multiSelect.clearSelection')"
              @click="clearSelection"
            >
              <i class="i-tabler-x" aria-hidden="true" />
            </PButton>
          </div>
        </div>
        <div class="text-fg-subtle flex flex-wrap gap-x-2 gap-y-0.5 items-center">
          <span v-if="totalSize > 0" class="tabular-nums">
            {{ filesize(totalSize) }}
          </span>
          <span v-if="totalSize > 0 && extensionDist.length > 0" class="op50" aria-hidden="true">·</span>
          <span v-if="extensionDist.length > 0" class="font-mono">
            {{ extensionDist.map(([e]) => e).join(', ') }}
          </span>
          <span
            v-if="missingCount > 0"
            class="text-[10px] text-fg-subtle ml-auto"
            :title="$t('multiSelect.outsideNote', { missing: missingCount, known: knownCount }, missingCount)"
          >
            {{ $t('multiSelect.inView', { known: formatNumber(knownCount), total: formatNumber(count) }) }}
            <span class="sr-only">{{ $t('multiSelect.outsideNote', { missing: missingCount, known: knownCount }, missingCount) }}</span>
          </span>
        </div>
      </div>

      <!-- isolate: the thumb pile (inline zIndex 0..Z_LEVELS-1) and the
           overflow badge form a self-contained local stacking context, so the
           badge's z sits above the topmost thumb without leaking outward. -->
      <div
        v-if="displayedThumbs.length > 0"
        role="group"
        :aria-labelledby="thumbsLabelId"
        class="flex shrink-0 h-50 w-full select-none items-center justify-center relative isolate"
      >
        <span :id="thumbsLabelId" class="sr-only">{{ $t('multiSelect.thumbnailsLabel') }}</span>
        <button
          v-for="d of displayedThumbs"
          :key="d.id"
          type="button"
          class="rounded-sm bg-surface cursor-pointer ring-1 ring-border-default shadow-sm left-1/2 top-1/2 absolute overflow-hidden hover:ring-primary"
          :style="{
            ...thumbStyle(d.post, d.idx),
            opacity: d.opacity,
            transition: `opacity ${d.duration}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          }"
          :title="`${d.post.fileName}.${d.post.extension}`"
          :aria-label="$t('multiSelect.showOnly', { name: `${d.post.fileName}.${d.post.extension}` })"
          :tabindex="d.phase === 'shown' ? undefined : -1"
          @click="focusOne(d.id)"
        >
          <img
            :src="getPostThumbnailURL(d.post)"
            alt=""
            class="h-full w-full block object-cover"
            draggable="false"
          >
        </button>
        <div
          v-if="overflowCount > 0"
          class="text-sm text-fg tracking-tight font-semibold px-2.5 py-1 rounded-full bg-surface pointer-events-none ring-1 ring-border-default shadow-sm left-1/2 top-1/2 absolute tabular-nums -translate-x-1/2 -translate-y-1/2"
          :style="{ zIndex: Z_LEVELS }"
          aria-hidden="true"
        >
          +{{ overflowCount }}
        </div>
      </div>

      <section class="py-3 p-divider">
        <h3
          class="p-section-title mb-2"
        >
          <i class="i-tabler-edit" aria-hidden="true" />
          <span>{{ $t('multiSelect.batch') }}</span>
        </h3>
        <div class="gap-x-3 gap-y-2 grid grid-cols-[auto_1fr_auto] items-center">
          <div :id="ratingLabelId">
            {{ $t('post.ratingLabel') }}
          </div>
          <PRating
            :aria-labelledby="ratingLabelId"
            :mixed="commonRating === null && knownCount > 0"
            :model-value="commonRating ?? 0"
            highlight-selected-only
            :count="4"
            :colors="RATING_LEVEL_COLORS"
            :icons="RATING_LEVEL_ICONS"
            :labels="RATING_LEVEL_NAMES"
            @select="applyRating"
          />
          <span
            v-if="commonRating === null && knownCount > 0"
            class="text-[10px] text-fg-subtle tracking-wide uppercase"
            aria-hidden="true"
          >{{ $t('common.mixed') }}</span>
          <span
            v-else
            class="text-fg-subtle text-right truncate"
            aria-hidden="true"
          >{{ commonRating ? RATING_LEVEL_NAMES[commonRating - 1] : '' }}</span>

          <div :id="scoreLabelId">
            {{ $t('post.scoreLabel') }}
          </div>
          <PRating
            :aria-labelledby="scoreLabelId"
            :mixed="commonScore === null && knownCount > 0"
            :model-value="commonScore ?? 0"
            :count="5"
            @select="applyScore"
          />
          <span
            v-if="commonScore === null && knownCount > 0"
            class="text-[10px] text-fg-subtle tracking-wide uppercase"
            aria-hidden="true"
          >{{ $t('common.mixed') }}</span>
          <span v-else />
        </div>
        <div class="mt-3 flex flex-col gap-2">
          <BatchTagPicker :ids="selectedIdList" />
          <PButton
            size="sm"
            variant="subtle"
            block
            @click="copyPaths"
          >
            <i class="i-tabler-copy" aria-hidden="true" />
            {{ $t('multiSelect.copyPaths') }}
          </PButton>
          <PButton
            size="sm"
            variant="subtle"
            block
            :disabled="count < 2"
            :loading="isGrouping"
            :title="$t('post.groupUserPriorityNote')"
            @click="groupSelected"
          >
            <i class="i-tabler-stack-2" aria-hidden="true" />
            {{ $t('multiSelect.groupSelected') }}
          </PButton>
        </div>
      </section>

      <section
        v-if="knownCount > 0"
        class="py-3 p-divider"
      >
        <h3
          class="p-section-title mb-2"
        >
          <i class="i-tabler-chart-bar" aria-hidden="true" />
          <span>{{ $t('multiSelect.distribution') }}</span>
        </h3>
        <div class="flex flex-col gap-2.5">
          <div class="flex flex-col gap-1">
            <div class="text-fg-subtle flex items-center justify-between">
              <span>{{ $t('post.ratingLabel') }}</span>
              <span class="text-[10px] text-fg-subtle tabular-nums" aria-hidden="true">{{ RATING_LEGEND }}</span>
            </div>
            <!-- The bar is a picture; its numbers are in the sr-only list. -->
            <div class="rounded-full bg-surface-3 flex h-1.5 overflow-hidden" aria-hidden="true">
              <div
                v-for="(n, i) of ratingDist"
                :key="i"
                :style="{ width: `${pct(n)}%`, backgroundColor: RATING_COLORS[i] }"
                :title="$t('multiSelect.distItem', { label: RATING_LABELS[i], n: formatNumber(n) })"
              />
            </div>
            <ul class="sr-only">
              <li v-for="(n, i) of ratingDist" :key="i">
                {{ $t('multiSelect.distItem', { label: RATING_FULL_LABELS[i], n: formatNumber(n) }) }}
              </li>
            </ul>
          </div>
          <div class="flex flex-col gap-1">
            <div class="text-fg-subtle flex items-center justify-between">
              <span>{{ $t('post.scoreLabel') }}</span>
              <span class="text-[10px] text-fg-subtle tabular-nums" aria-hidden="true">{{ SCORE_LEGEND }}</span>
            </div>
            <div class="rounded-full bg-surface-3 flex h-1.5 overflow-hidden" aria-hidden="true">
              <div
                v-for="(n, i) of scoreDist"
                :key="i"
                :style="{ width: `${pct(n)}%`, backgroundColor: SCORE_COLORS[i] }"
                :title="$t('multiSelect.distItem', { label: SCORE_LABELS[i], n: formatNumber(n) })"
              />
            </div>
            <ul class="sr-only">
              <li v-for="(n, i) of scoreDist" :key="i">
                {{ $t('multiSelect.distItem', { label: SCORE_LABELS[i], n: formatNumber(n) }) }}
              </li>
            </ul>
          </div>
        </div>
      </section>

      <section
        v-if="knownCount > 0"
        class="py-3"
      >
        <h3
          class="p-section-title mb-2"
        >
          <i class="i-tabler-files" aria-hidden="true" />
          <span>{{ $t('multiSelect.files') }}</span>
        </h3>
        <div
          class="gap-y-2 p-kv-grid odd:children:text-fg-subtle"
        >
          <div>{{ $t('multiSelect.format') }}</div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="[ext, n] of extensionDist"
              :key="ext"
              class="text-2xs font-mono px-1.5 py-0.5 border border-border-subtle rounded-sm uppercase tabular-nums"
            >
              {{ ext }} <span class="text-fg-subtle normal-case">×{{ n }}</span>
            </span>
          </div>
          <div>{{ $t('multiSelect.width') }}</div>
          <div v-if="widthRange" class="tabular-nums">
            {{ formatNumber(widthRange.min) }} – {{ formatNumber(widthRange.max) }} px
          </div>
          <div v-else>
            —
          </div>
          <div>{{ $t('multiSelect.height') }}</div>
          <div v-if="heightRange" class="tabular-nums">
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

      <div class="mt-auto pb-3 pt-4">
        <PButton
          size="sm"
          block
          :variant="deleteTarget === null ? 'subtle' : 'danger'"
          :loading="isDeleting"
          @click="deleteSelected"
          @blur="deleteConfirm.cancel()"
        >
          <i v-if="!isDeleting" class="i-tabler-trash" aria-hidden="true" />
          {{ deleteTarget === null ? $t('multiSelect.deleteSelected') : $t('multiSelect.deleteConfirm', { n: formatNumber(deleteTarget.length) }) }}
        </PButton>
      </div>
    </div>
  </PScrollArea>
</template>
