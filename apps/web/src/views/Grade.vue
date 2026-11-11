<script setup lang="ts">
import type { AgreementPublic } from '@/api'
import type { GradingCard } from '@/shared/gradingDeck'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GradingAnchors, v2GradingDeck, v2GradingStats } from '@/api'
import AnnotationKeyHints from '@/components/annotate/AnnotationKeyHints.vue'
import { noLayerOpen } from '@/composables/useAnnotationKeymap'
import { useAPIError } from '@/composables/useAPIError'
import { preloadImage } from '@/composables/usePostPrefetch'
import { formatNumber } from '@/locale'
import { gradePost } from '@/shared'
import { appendCards, EMPTY_DECK, grade, gradeSource, needsRefill, restoreGrade, step, verdict } from '@/shared/gradingDeck'
import { queryKeys } from '@/shared/queryKeys'
import { useHotkey } from '@/ui/useHotkey'
import { getPostImageURL, getPostThumbnailURL } from '@/utils'

// Fast blind grading: one picture, ← / → to move, 1-5 to grade. What gets drawn
// (new pictures vs. re-grades, and in what proportion) is decided server-side —
// see `repositories/grading.ts` in @pictoria/db; this page only plays the deck.
const GRADES = [1, 2, 3, 4, 5] as const
const BATCH = 30
const PRELOAD_AHEAD = 3

const { t } = useI18n()
const { handle: handleAPIError } = useAPIError()
const queryClient = useQueryClient()

const deck = shallowRef(EMPTY_DECK)
const loading = ref(false)
const loadFailed = ref(false)
// The sampler came back with nothing new: stop asking (everything left was
// graded within the cooldown, or the library is empty).
const exhausted = ref(false)

const current = computed<GradingCard | undefined>(() => deck.value.cards[deck.value.index])
const sessionCount = computed(() => deck.value.cards.filter(c => c.given !== undefined).length)

async function refill() {
  if (loading.value || exhausted.value) {
    return
  }
  loading.value = true
  loadFailed.value = false
  try {
    const resp = await v2GradingDeck({ query: { limit: BATCH } })
    const next = appendCards(deck.value, resp.data ?? [])
    exhausted.value = next === deck.value
    deck.value = next
  }
  catch (error) {
    loadFailed.value = true
    handleAPIError(error, t('grade.error.load'))
  }
  finally {
    loading.value = false
  }
}

watch(deck, (d) => {
  if (needsRefill(d)) {
    void refill()
  }
  // Warm the next few originals: by the time a grade is in, the next picture
  // is already in the browser cache.
  for (const card of d.cards.slice(d.index + 1, d.index + 1 + PRELOAD_AHEAD)) {
    preloadImage(getPostImageURL(card.post))
  }
}, { immediate: true })

const { data: stats } = useQuery({
  queryKey: queryKeys.gradingStats,
  queryFn: async () => {
    const resp = await v2GradingStats()
    return resp.data
  },
})

// The reference pictures are fixed server-side (that is the point of them), so
// one fetch per visit is enough.
const { data: anchors } = useQuery({
  queryKey: queryKeys.gradingAnchors,
  queryFn: async () => {
    const resp = await v2GradingAnchors()
    return resp.data
  },
  staleTime: Infinity,
})
const anchorRows = computed(() => (anchors.value ?? []).filter(row => row.posts.length > 0))

async function give(value: number) {
  const card = current.value
  if (!card) {
    return
  }
  const before = card.given
  const source = gradeSource(card)
  // Screen first, request after: the next picture must not wait on the write.
  deck.value = grade(deck.value, value)
  try {
    await gradePost(queryClient, card.post.id, value, source)
  }
  catch (error) {
    deck.value = restoreGrade(deck.value, card.post.id, before)
    handleAPIError(error, t('grade.error.save'))
  }
}

const active = () => noLayerOpen() && !!current.value
for (const g of GRADES) {
  useHotkey(String(g), () => void give(g), { when: active, repeat: false })
}
useHotkey('ArrowLeft', () => {
  deck.value = step(deck.value, -1)
}, { when: active })
useHotkey('ArrowRight', () => {
  deck.value = step(deck.value, 1)
}, { when: active })

function percent(a: AgreementPublic | undefined): string {
  return a?.exact == null ? '—' : `${Math.round(a.exact * 100)}%`
}

/** What a graded card reveals: the earlier human grade (re-grades only) and the model's. */
const reveal = computed(() => {
  const card = current.value
  if (card?.given === undefined) {
    return []
  }
  const rows: { label: string, value: number, verdict: string }[] = []
  if (card.previous > 0) {
    rows.push({ label: t('grade.reveal.previous'), value: card.previous, verdict: verdict(card.given, card.previous) })
  }
  if (card.model != null) {
    rows.push({ label: t('grade.reveal.model'), value: card.model, verdict: verdict(card.given, card.model) })
  }
  return rows
})

const hints = computed(() => [
  { keys: ['1–5'], label: t('grade.keys.grade') },
  { keys: ['←'], label: t('grade.keys.previous') },
  { keys: ['→'], label: t('grade.keys.next') },
])
</script>

<template>
  <div class="grade-page flex flex-col h-full" role="region" :aria-label="$t('grade.title')">
    <!-- 顶栏：标题、实时一致度、键位 -->
    <div class="text-sm px-4 py-2.5 p-divider flex shrink-0 gap-4 items-center justify-between">
      <div class="flex gap-4 min-w-0 items-center">
        <h1 class="text-fg font-medium shrink-0">
          {{ $t('grade.title') }}
        </h1>
        <dl class="grade-stats" role="status">
          <div :title="$t('grade.stats.selfHint')">
            <dt>{{ $t('grade.stats.self') }}</dt>
            <dd>{{ percent(stats?.self) }}<span v-if="stats?.self.n">{{ $t('grade.stats.count', { n: formatNumber(stats.self.n) }) }}</span></dd>
          </div>
          <div :title="$t('grade.stats.modelHint')">
            <dt>{{ $t('grade.stats.model') }}</dt>
            <dd>{{ percent(stats?.model) }}<span v-if="stats?.model.n">{{ $t('grade.stats.count', { n: formatNumber(stats.model.n) }) }}</span></dd>
          </div>
          <div>
            <dt>{{ $t('grade.stats.today') }}</dt>
            <dd>{{ formatNumber(stats?.gradedToday ?? 0) }}</dd>
          </div>
        </dl>
      </div>
      <div class="text-xs text-fg-muted flex shrink-0 gap-4 items-center">
        <span v-if="deck.cards.length > 0" class="text-fg font-medium tabular-nums">
          {{ $t('grade.progress', { done: formatNumber(sessionCount) }) }}
        </span>
        <AnnotationKeyHints :hints="hints" />
      </div>
    </div>

    <template v-if="current">
      <!-- 图片区：两侧是翻页 -->
      <div class="flex flex-1 min-h-0 items-stretch">
        <button
          type="button"
          class="grade-nav"
          :disabled="deck.index === 0"
          :aria-label="$t('grade.keys.previous')"
          aria-keyshortcuts="ArrowLeft"
          @click="deck = step(deck, -1)"
        >
          <i class="i-tabler-chevron-left" aria-hidden="true" />
        </button>
        <div class="bg-bg flex flex-1 min-w-0 items-center justify-center">
          <img
            :key="current.post.id"
            :src="getPostImageURL(current.post)"
            :alt="current.post.fileName"
            class="max-h-full max-w-full object-contain"
            decoding="async"
          >
        </div>
        <button
          type="button"
          class="grade-nav"
          :disabled="deck.index >= deck.cards.length - 1"
          :aria-label="$t('grade.keys.next')"
          aria-keyshortcuts="ArrowRight"
          @click="deck = step(deck, 1)"
        >
          <i class="i-tabler-chevron-right" aria-hidden="true" />
        </button>
        <!-- 参照图：每档固定几张，标准跟着它们走而不是跟着上一张走 -->
        <aside v-if="anchorRows.length > 0" class="grade-anchors" :aria-label="$t('grade.anchors.title')">
          <p class="grade-anchors__hint">
            {{ $t('grade.anchors.hint') }}
          </p>
          <div v-for="row in anchorRows" :key="row.grade" class="grade-anchors__row" :class="{ 'grade-anchors__row--given': current.given === row.grade }">
            <span class="grade-anchors__grade" :aria-label="$t('grade.anchors.row', { grade: row.grade })">{{ row.grade }}</span>
            <img
              v-for="post in row.posts"
              :key="post.id"
              :src="getPostThumbnailURL(post)"
              :alt="post.fileName"
              class="grade-anchors__thumb"
              loading="lazy"
              decoding="async"
            >
          </div>
        </aside>
      </div>

      <!-- 底栏：五档 + 打完才揭晓的旧分 / 模型分 -->
      <div class="px-4 py-3 border-t border-border-subtle flex shrink-0 gap-6 items-center justify-center">
        <div class="flex gap-2" role="group" :aria-label="$t('grade.gradeGroup')">
          <button
            v-for="g in GRADES"
            :key="g"
            type="button"
            class="grade-key"
            :class="{ 'grade-key--given': current.given === g }"
            :aria-pressed="current.given === g"
            :aria-keyshortcuts="String(g)"
            @click="give(g)"
          >
            {{ g }}
          </button>
        </div>
        <div class="grade-reveal" role="status">
          <template v-if="reveal.length > 0">
            <span v-for="row in reveal" :key="row.label" class="grade-reveal__item" :class="`grade-reveal__item--${row.verdict}`">
              {{ row.label }} <b>{{ row.value }}</b>
            </span>
          </template>
          <span v-else-if="current.given === undefined" class="text-fg-muted">{{ $t('grade.reveal.blind') }}</span>
        </div>
      </div>
    </template>

    <!-- 空态 -->
    <div v-else class="flex flex-1 items-center justify-center">
      <PEmpty v-if="loadFailed" icon="i-tabler-alert-triangle">
        <span class="text-fg font-medium block">{{ $t('grade.error.load') }}</span>
        <template #action>
          <PButton size="sm" variant="primary" class="mt-2" @click="refill()">
            {{ $t('grade.retry') }}
          </PButton>
        </template>
      </PEmpty>
      <PEmpty v-else-if="exhausted" icon="i-tabler-circle-check">
        <span class="text-fg font-medium block">{{ $t('grade.empty') }}</span>
        <span class="text-xs text-fg-muted mt-1 block">{{ $t('grade.emptyHint') }}</span>
      </PEmpty>
      <div v-else role="status" class="text-sm text-fg-muted">
        {{ $t('common.loading') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.grade-stats {
  display: flex;
  gap: 16px;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  color: var(--p-fg-muted);
}
.grade-stats > div {
  display: flex;
  gap: 6px;
  align-items: baseline;
  white-space: nowrap;
}
.grade-stats dd {
  margin: 0;
  color: var(--p-fg);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.grade-stats dd span {
  margin-left: 4px;
  color: var(--p-fg-muted);
  font-weight: 400;
}

.grade-nav {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 44px;
  border: none;
  background: transparent;
  color: var(--p-fg-muted);
  font-size: 20px;
  cursor: pointer;
  transition: background-color var(--p-transition-fast), color var(--p-transition-fast);
}
.grade-nav:hover:not(:disabled) {
  background: rgb(var(--p-primary-rgb) / 0.08);
  color: var(--p-fg);
}
.grade-nav:disabled {
  opacity: 0.3;
  cursor: default;
}

.grade-anchors {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  gap: 8px;
  width: 312px;
  padding: 12px;
  border-left: 1px solid var(--p-border-subtle);
  overflow-y: auto;
}
.grade-anchors__hint {
  margin: 0 0 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--p-fg-muted);
}
.grade-anchors__row {
  display: grid;
  grid-template-columns: 20px repeat(3, 1fr);
  gap: 6px;
  align-items: center;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--p-radius-lg);
  transition: border-color var(--p-transition-fast), background-color var(--p-transition-fast);
}
.grade-anchors__row--given {
  border-color: var(--p-primary);
  background: rgb(var(--p-primary-rgb) / 0.1);
}
.grade-anchors__grade {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--p-fg);
}
.grade-anchors__thumb {
  width: 100%;
  aspect-ratio: 3 / 4;
  object-fit: cover;
  border-radius: var(--p-radius-sm);
  background: var(--p-border-subtle);
}

.grade-key {
  width: 52px;
  height: 44px;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-lg);
  background: transparent;
  color: var(--p-fg);
  font-size: 17px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color var(--p-transition-fast), border-color var(--p-transition-fast);
}
.grade-key:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.6);
  background: rgb(var(--p-primary-rgb) / 0.08);
}
.grade-key--given {
  border-color: var(--p-primary);
  background: rgb(var(--p-primary-rgb) / 0.18);
}

.grade-reveal {
  display: flex;
  gap: 14px;
  min-width: 190px;
  font-size: 13px;
}
.grade-reveal__item {
  color: var(--p-fg-muted);
  font-variant-numeric: tabular-nums;
}
.grade-reveal__item b {
  font-weight: 600;
}
.grade-reveal__item--same b {
  color: var(--p-success);
}
.grade-reveal__item--near b {
  color: var(--p-warning);
}
.grade-reveal__item--far b {
  color: rgb(var(--p-danger-rgb));
}
</style>
