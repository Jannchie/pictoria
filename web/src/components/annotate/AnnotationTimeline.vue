<script setup lang="ts">
import type { TimelineEntryPublic } from '@/api'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { useIntersectionObserver, useIntervalFn } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2AnnotationTimeline } from '@/api'
import { formatDateTime, formatRelativeTime } from '@/locale'
import { canReview, flagGlyph, reviewing, startReview, winnerLabel } from '@/shared'
import { queryKeys } from '@/shared/queryKeys'
import { PScrollArea } from '@/ui'
import { getPostThumbnailURL } from '@/utils'

const { t } = useI18n()

// A page is bigger than a screenful so the first scroll never stalls, and small
// enough that the posts join behind it stays a handful of rows.
const PAGE = 30

const query = useInfiniteQuery({
  queryKey: queryKeys.annotationTimeline,
  queryFn: async ({ pageParam }) => {
    const resp = await v2AnnotationTimeline({
      query: { limit: PAGE, ...(pageParam ? { before: pageParam as string } : {}) },
    })
    return resp.data
  },
  initialPageParam: '',
  // This cache is authoritative between fetches: the session patches it on every
  // submit/undo/edit precisely so the list never has to refetch on the hot path.
  // Left on the defaults (staleTime 0 + refetchOnWindowFocus), one alt-tab away and
  // back re-runs EVERY loaded page sequentially — measured ~110ms of server work per
  // page at 200k events, i.e. seconds of stall on the screen you tab away from.
  staleTime: 1000 * 60 * 5,
  refetchOnWindowFocus: false,
  // Page until the server stops handing back a cursor, NOT until a page looks
  // short: an event whose picture was deleted is dropped from its page, so a
  // short page can still have more behind it.
  getNextPageParam: last => last?.nextCursor ?? undefined,
})

const entries = computed(() => query.data.value?.pages.flatMap(p => p?.items ?? []) ?? [])

// One instant for the whole list, so every "N ago" on screen is measured against the
// same clock read rather than drifting row by row. Re-stamped on a timer because the
// times keep aging while the panel sits open, and on a length change so a row the
// session just prepended is not dated by a stamp taken up to a tick earlier.
const renderedAt = ref(Date.now())
function stampNow() {
  renderedAt.value = Date.now()
}
useIntervalFn(stampNow, 30_000)
watch(() => entries.value.length, stampNow)

function rowKey(e: TimelineEntryPublic) {
  return `${e.kind}-${e.id}`
}

// Selecting a row hands it to the session, which shows the pictures full size and
// re-judges with the same keys used to judge them in the first place. Editing from
// a 34px thumbnail in this list was the wrong surface for the one decision this is:
// looking at two pictures and saying which is better.
function pick(e: TimelineEntryPublic) {
  if (canReview(e)) {
    startReview(e)
  }
}

// Flags can never be re-judged by any session ('none' is their own retraction), so
// they must not be told to go start one — that hint is only true for a kind whose
// session simply is not running.
function reviewTitle(e: TimelineEntryPublic) {
  if (canReview(e)) {
    return t('annotate.history.reviewHint')
  }
  return t(e.kind === 'flag' ? 'annotate.history.reviewNever' : 'annotate.history.reviewUnavailable')
}

function isActive(e: TimelineEntryPublic) {
  return reviewing.value?.kind === e.kind && reviewing.value?.id === e.id
}

// PScrollArea scrolls an inner div, so the observer root is the element it exposes
// as $el — the component root itself does not scroll (same pattern as MainSection).
const scrollArea = ref<{ $el?: HTMLElement }>()
const scrollEl = computed(() => scrollArea.value?.$el)
const sentinel = ref<HTMLElement>()
useIntersectionObserver(
  sentinel,
  ([entry]) => {
    if (!entry?.isIntersecting) {
      return
    }
    // Both guards matter: the observer can fire again before the in-flight page
    // resolves and pushes the sentinel down.
    if (query.hasNextPage.value && !query.isFetchingNextPage.value) {
      query.fetchNextPage()
    }
  },
  { root: scrollEl, rootMargin: '400px' },
)
</script>

<template>
  <div class="text-xs flex flex-col h-full">
    <div class="px-3 py-2.5 p-divider flex shrink-0 items-center justify-between">
      <span class="text-fg font-medium">{{ $t('annotate.history.title') }}</span>
      <button
        class="timeline-icon"
        :title="$t('annotate.history.refresh')"
        @click="query.refetch()"
      >
        <i class="i-tabler-refresh" />
      </button>
    </div>

    <PScrollArea ref="scrollArea" class="flex-1 min-h-0">
      <div v-if="entries.length === 0 && !query.isLoading.value" class="text-fg-muted px-3 py-6 text-center">
        {{ $t('annotate.history.empty') }}
      </div>

      <ul class="flex flex-col">
        <li v-for="e in entries" :key="rowKey(e)" class="p-divider">
          <button
            class="timeline-row"
            :class="{ 'timeline-row--active': isActive(e), 'timeline-row--static': !canReview(e) }"
            :disabled="!canReview(e)"
            :aria-pressed="isActive(e)"
            :title="reviewTitle(e)"
            @click="pick(e)"
          >
            <span class="flex shrink-0 gap-0.5">
              <img
                :src="getPostThumbnailURL(e.post)"
                :alt="e.post.fileName"
                class="timeline-thumb"
                :class="{ 'timeline-thumb--won': e.kind === 'pairwise' && e.winner === 'a' }"
                loading="lazy"
                decoding="async"
              >
              <img
                v-if="e.postB"
                :src="getPostThumbnailURL(e.postB)"
                :alt="e.postB.fileName"
                class="timeline-thumb"
                :class="{ 'timeline-thumb--won': e.winner === 'b' }"
                loading="lazy"
                decoding="async"
              >
            </span>

            <span class="flex flex-col gap-0.5 min-w-0 items-start">
              <span class="text-fg font-medium truncate">
                <template v-if="e.kind === 'pairwise'">{{ winnerLabel(e.winner) }}</template>
                <template v-else-if="e.kind === 'absolute'">{{ e.value }} / {{ e.scale }}</template>
                <template v-else>{{ flagGlyph(e.flag) }}</template>
              </span>
              <span class="text-fg-muted truncate">
                {{ e.dimension }}
                <span v-if="e.editedAt" class="timeline-edited">{{ $t('annotate.history.edited') }}</span>
              </span>
            </span>

            <span class="text-fg-subtle ml-auto shrink-0" :title="formatDateTime(e.createdAt)">
              {{ formatRelativeTime(e.createdAt, renderedAt) }}
            </span>
          </button>
        </li>
      </ul>

      <div ref="sentinel" class="h-1" />
      <div v-if="query.isFetchingNextPage.value || query.isLoading.value" class="text-fg-muted px-3 py-3 text-center">
        {{ $t('common.loading') }}
      </div>
    </PScrollArea>
  </div>
</template>

<style scoped>
.timeline-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--p-radius-sm);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition: background-color var(--p-transition-fast), color var(--p-transition-fast);
}
.timeline-icon:hover {
  background: rgb(var(--p-primary-rgb) / 0.12);
  color: var(--p-fg);
}

.timeline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--p-transition-fast);
}
.timeline-row:hover {
  background: rgb(var(--p-primary-rgb) / 0.08);
}
.timeline-row--active {
  background: rgb(var(--p-primary-rgb) / 0.16);
  box-shadow: inset 2px 0 0 var(--p-primary);
}
.timeline-row--static {
  cursor: default;
}

.timeline-thumb {
  width: 34px;
  height: 34px;
  object-fit: cover;
  border-radius: var(--p-radius-xs);
  background: var(--p-bg-subtle);
  /* Transparent by default so the winning side's ring does not shift layout. */
  outline: 2px solid transparent;
  outline-offset: -2px;
}
.timeline-thumb--won {
  outline-color: var(--p-primary);
}

.timeline-edited {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: var(--p-radius-xs);
  background: rgb(var(--p-primary-rgb) / 0.14);
  color: var(--p-fg-muted);
}
</style>
