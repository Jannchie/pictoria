<script setup lang="ts">
import type { QueueSummaryPublic } from '@/api'
import type { StreamConfig } from '@/components/annotate/AbsoluteAnnotationSession.vue'
import type { AbsoluteStrategy, AnnotationDimension, AnnotationScale, PairwiseStrategy, QueueKind } from '@/shared/annotationTypes'
import { useQuery } from '@tanstack/vue-query'
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GenerateAbsolute, v2GenerateListwise, v2GeneratePairwise, v2ListQueues } from '@/api'
import AbsoluteAnnotationSession from '@/components/annotate/AbsoluteAnnotationSession.vue'
import ListwiseAnnotationSession from '@/components/annotate/ListwiseAnnotationSession.vue'
import PairwiseAnnotationSession from '@/components/annotate/PairwiseAnnotationSession.vue'
import { useAPIError } from '@/composables/useAPIError'
import { useRovingFocus } from '@/composables/useRovingFocus'
import { formatNumber } from '@/locale'
import { DIMENSION_META, dimensionMeta } from '@/shared/annotationTypes'
import { queryKeys } from '@/shared/queryKeys'
import { PSwitch } from '@/ui'
import { focusElement } from '@/utils/focus'

const { handle: handleAPIError } = useAPIError()
const { t } = useI18n()

type Session
  = | { mode: 'queue', queue: QueueSummaryPublic }
    | { mode: 'stream-absolute', config: StreamConfig }
    | { mode: 'stream-pairwise', dimension: AnnotationDimension, strategy: PairwiseStrategy }
    | { mode: 'stream-listwise', dimension: AnnotationDimension, size: number, repeat?: number }

const session = ref<Session | null>(null)

const { data: queues, refetch } = useQuery({
  queryKey: queryKeys.annotationQueues,
  queryFn: async () => {
    const resp = await v2ListQueues()
    return resp.data ?? []
  },
})

// Leaving a session unmounts it; put focus back on the launcher rather than <body>.
const startButton = useTemplateRef<{ $el?: HTMLElement }>('startButton')
function exitSession() {
  session.value = null
  refetch()
  void nextTick(() => focusElement(startButton.value?.$el, { preventScroll: true }))
}

// ── 标注配置（流式为默认路径，队列仅用于固定批次实验）────────────
//
// 双图对比只问总分。四个维度（颜色/完成度/构图）在 2026-06 试过：overall 累计 2900+ 条，
// 三个分维度加起来 88 条就停了——分维度判断慢、自己跟自己也不一致，而 SILVA 主线用的
// 一直是 overall。所以对比模式不再提供维度选择；维度只留给单图评分的实验路径。
const PAIRWISE_DIMENSION: AnnotationDimension = 'overall'

const DIMENSIONS = (['overall', 'color', 'finish', 'composition'] as const satisfies readonly AnnotationDimension[])
  .map(key => ({ key, ...DIMENSION_META[key] }))

// 默认 = 组内排序 4 张。比较判断绕开绝对分的天花板/通胀/漂移、窗口把标注花在模型自己
// 分不开的边界上 —— 这两条对双图对比同样成立；选组内排序是因为同样的信息它更便宜：
// 一次 n 张全序在 Plackett-Luce 下值 Σ_{k=2..n}(1−1/k)（silva 侧 fit_latent.py
// --rankings 正是这么吃的），而耗时几乎正比于 C(n,2)。2026-09-06 实测每 PL 对当量：
// 4 张 2.77 s、6 张 3.64 s、8 张 4.91 s，双图对比 2.12 s 但每次都要重新认识两张新图。
const form = ref({
  kind: 'listwise' as QueueKind,
  dimensions: ['overall'] as AnnotationDimension[], // 仅单图评分使用
  scale: 2 as AnnotationScale,
  strategy: 'stratified' as AbsoluteStrategy, // 单图评分采样
  pairwiseStrategy: 'close' as PairwiseStrategy,
  listwiseSize: 4,
  // 重测会话：整批都抽老组，用来量你自己判两次有多一致。平时是 undefined（服务端按
  // REPEAT_SHARE 收 5% 的税），只有专门测天花板时才打开。
  listwiseRetest: false,
})
// hint 报「秒 / 对当量」而不是「对 / 屏」：一屏展开的 C(n,2) 条边不是 C(n,2) 次独立
// 观测，全序由 n 个潜变量的一个排列生成，PL 信息 Σ_{k=2..n}(1−1/k) 折成势均力敌的
// pairwise 只有 3.8 / 7.1 / 10.6 对。而耗时几乎正比于边数，所以小组每单位信息更便宜。
const LISTWISE_SIZES = [
  { value: 4, hintKey: 'annotate.groupSize.hint4' },
  { value: 6, hintKey: 'annotate.groupSize.hint6' },
  { value: 8, hintKey: 'annotate.groupSize.hint8' },
]
const canStart = computed(() => form.value.kind !== 'absolute' || form.value.dimensions.length > 0)

function toggleDimension(d: AnnotationDimension) {
  const dims = form.value.dimensions
  form.value.dimensions = dims.includes(d) ? dims.filter(x => x !== d) : [...dims, d]
}

const SCALES: { value: AnnotationScale, labelKey: string, hintKey: string }[] = [
  { value: 2, labelKey: 'annotate.scale.binary', hintKey: 'annotate.scale.binaryHint' },
  { value: 3, labelKey: 'annotate.scale.ternary', hintKey: 'annotate.scale.ternaryHint' },
  { value: 5, labelKey: 'annotate.scale.five', hintKey: 'annotate.scale.fiveHint' },
]
const STRATEGIES = [
  { value: 'stratified' as const, labelKey: 'annotate.sampling.stratified', hintKey: 'annotate.sampling.stratifiedHint' },
  { value: 'random' as const, labelKey: 'annotate.sampling.random', hintKey: 'annotate.sampling.randomHint' },
]
const PAIRWISE_STRATEGIES = [
  { value: 'close' as const, labelKey: 'annotate.pairing.close', hintKey: 'annotate.pairing.closeHint' },
  { value: 'similar' as const, labelKey: 'annotate.pairing.similar', hintKey: 'annotate.pairing.similarHint' },
  { value: 'random' as const, labelKey: 'annotate.pairing.random', hintKey: 'annotate.pairing.randomHint' },
]
const MODES: { value: QueueKind, labelKey: string, hintKey: string, icon: string }[] = [
  { value: 'absolute', labelKey: 'annotate.mode.absolute', hintKey: 'annotate.mode.absoluteHint', icon: 'i-tabler-photo' },
  { value: 'pairwise', labelKey: 'annotate.mode.pairwise', hintKey: 'annotate.mode.pairwiseHint', icon: 'i-tabler-layout-columns' },
  { value: 'listwise', labelKey: 'annotate.mode.listwise', hintKey: 'annotate.mode.listwiseHint', icon: 'i-tabler-layout-grid' },
]
function dimensionLabel(d: string) {
  const meta = dimensionMeta(d)
  return meta ? t(meta.labelKey) : d
}
const KIND_LABEL_KEYS: Record<QueueKind, string> = {
  absolute: 'annotate.mode.absolute',
  pairwise: 'annotate.mode.pairwise',
  listwise: 'annotate.mode.listwise',
}

// Each option set is an APG radio group: one Tab stop, arrows move AND select (these
// are plain settings, nothing is committed until Start), Space/Enter select too.
const ids = useId()
const modeGroup = useTemplateRef<HTMLElement>('modeGroup')
const pairingGroup = useTemplateRef<HTMLElement>('pairingGroup')
const sizeGroup = useTemplateRef<HTMLElement>('sizeGroup')
const scaleGroup = useTemplateRef<HTMLElement>('scaleGroup')
const samplingGroup = useTemplateRef<HTMLElement>('samplingGroup')
for (const container of [modeGroup, pairingGroup, sizeGroup, scaleGroup, samplingGroup]) {
  useRovingFocus({ container, itemSelector: '[role=radio]', orientation: 'horizontal', onMove: el => el.click() })
}

function startStream() {
  if (!canStart.value) {
    return
  }
  session.value = form.value.kind === 'absolute'
    ? {
        mode: 'stream-absolute',
        config: {
          dimensions: DIMENSIONS.map(d => d.key).filter(k => form.value.dimensions.includes(k)),
          scale: form.value.scale,
          strategy: form.value.strategy,
        },
      }
    : form.value.kind === 'listwise'
      ? {
          mode: 'stream-listwise',
          dimension: PAIRWISE_DIMENSION,
          size: form.value.listwiseSize,
          repeat: form.value.listwiseRetest ? 1 : undefined,
        }
      : { mode: 'stream-pairwise', dimension: PAIRWISE_DIMENSION, strategy: form.value.pairwiseStrategy }
}

// ── 队列（固定批次：形态对比实验 / intra-rater 复测用）──────────
const showQueues = ref(false)
const generating = ref(false)
const queueCount = ref(200)

async function generateQueue() {
  if (!canStart.value || generating.value) {
    return
  }
  generating.value = true
  try {
    await (form.value.kind === 'absolute'
      ? v2GenerateAbsolute({
          body: {
            dimensions: DIMENSIONS.map(d => d.key).filter(k => form.value.dimensions.includes(k)),
            scale: form.value.scale,
            count: queueCount.value,
            strategy: form.value.strategy,
          },
        })
      : form.value.kind === 'listwise'
        ? v2GenerateListwise({
            body: { dimension: PAIRWISE_DIMENSION, count: queueCount.value, size: form.value.listwiseSize },
          })
        : v2GeneratePairwise({
            body: { dimension: PAIRWISE_DIMENSION, count: queueCount.value, strategy: form.value.pairwiseStrategy },
          }))
    await refetch()
  }
  catch (error) {
    handleAPIError(error, t('annotate.error.generateQueue'))
  }
  finally {
    generating.value = false
  }
}
</script>

<template>
  <div class="text-fg bg-bg h-full overflow-y-auto">
    <AbsoluteAnnotationSession
      v-if="session?.mode === 'queue' && session.queue.kind === 'absolute'"
      :queue="session.queue"
      @exit="exitSession"
    />
    <PairwiseAnnotationSession
      v-else-if="session?.mode === 'queue' && session.queue.kind === 'pairwise'"
      :queue="session.queue"
      @exit="exitSession"
    />
    <ListwiseAnnotationSession
      v-else-if="session?.mode === 'queue' && session.queue.kind === 'listwise'"
      :queue="session.queue"
      @exit="exitSession"
    />
    <AbsoluteAnnotationSession
      v-else-if="session?.mode === 'stream-absolute'"
      :config="session.config"
      @exit="exitSession"
    />
    <PairwiseAnnotationSession
      v-else-if="session?.mode === 'stream-pairwise'"
      :dimension="session.dimension"
      :strategy="session.strategy"
      @exit="exitSession"
    />
    <ListwiseAnnotationSession
      v-else-if="session?.mode === 'stream-listwise'"
      :dimension="session.dimension"
      :size="session.size"
      :repeat="session.repeat"
      @exit="exitSession"
    />

    <div v-else class="mx-auto px-6 pb-16 pt-10 max-w-xl">
      <!-- 页头 -->
      <header class="mb-8">
        <h1 class="text-2xl text-fg tracking-tight font-semibold">
          {{ $t('annotate.title') }}
        </h1>
        <p class="text-sm text-fg-muted leading-relaxed mt-1.5">
          {{ $t('annotate.intro') }}
        </p>
      </header>

      <!-- 模式：可选卡片（单选组） -->
      <section class="mb-7">
        <div :id="`${ids}-mode`" class="annotate-section-title">
          {{ $t('annotate.mode.title') }}
        </div>
        <div ref="modeGroup" role="radiogroup" :aria-labelledby="`${ids}-mode`" class="gap-2.5 grid grid-cols-3">
          <button
            v-for="m in MODES"
            :key="m.value"
            type="button"
            role="radio"
            :aria-checked="form.kind === m.value"
            class="annotate-mode-card"
            :class="{ 'annotate-mode-card--active': form.kind === m.value }"
            @click="form.kind = m.value"
          >
            <i :class="m.icon" class="text-lg" aria-hidden="true" />
            <div class="min-w-0">
              <div class="text-sm font-medium">
                {{ $t(m.labelKey) }}
              </div>
              <div class="text-xs text-fg-muted mt-0.5">
                {{ $t(m.hintKey) }}
              </div>
            </div>
          </button>
        </div>
      </section>

      <!-- 配对方式（对比模式）：segmented -->
      <section v-if="form.kind === 'pairwise'" class="mb-7">
        <div :id="`${ids}-pairing`" class="annotate-section-title">
          {{ $t('annotate.pairing.title') }}
          <span class="annotate-section-note">{{ $t('annotate.pairing.note') }}</span>
        </div>
        <div
          ref="pairingGroup"
          role="radiogroup"
          :aria-labelledby="`${ids}-pairing`"
          :aria-describedby="`${ids}-pairing-hint`"
          class="annotate-segment"
        >
          <button
            v-for="s in PAIRWISE_STRATEGIES"
            :key="s.value"
            type="button"
            role="radio"
            :aria-checked="form.pairwiseStrategy === s.value"
            class="annotate-segment__item"
            :class="{ 'annotate-segment__item--active': form.pairwiseStrategy === s.value }"
            :title="$t(s.hintKey)"
            @click="form.pairwiseStrategy = s.value"
          >
            {{ $t(s.labelKey) }}
          </button>
        </div>
        <p :id="`${ids}-pairing-hint`" class="text-xs text-fg-subtle leading-relaxed mt-2">
          {{ $t(PAIRWISE_STRATEGIES.find(s => s.value === form.pairwiseStrategy)?.hintKey ?? 'annotate.pairing.closeHint') }}
        </p>
      </section>

      <!-- 组大小（组内排序）：segmented -->
      <section v-if="form.kind === 'listwise'" class="mb-7">
        <div :id="`${ids}-size`" class="annotate-section-title">
          {{ $t('annotate.groupSize.title') }}
          <span class="annotate-section-note">{{ $t('annotate.groupSize.note') }}</span>
        </div>
        <div
          ref="sizeGroup"
          role="radiogroup"
          :aria-labelledby="`${ids}-size`"
          :aria-describedby="`${ids}-size-hint`"
          class="annotate-segment"
        >
          <button
            v-for="s in LISTWISE_SIZES"
            :key="s.value"
            type="button"
            role="radio"
            :aria-checked="form.listwiseSize === s.value"
            class="annotate-segment__item"
            :class="{ 'annotate-segment__item--active': form.listwiseSize === s.value }"
            :title="$t(s.hintKey)"
            @click="form.listwiseSize = s.value"
          >
            {{ $t('annotate.groupSize.option', { n: s.value }) }}
          </button>
        </div>
        <p :id="`${ids}-size-hint`" class="text-xs text-fg-subtle leading-relaxed mt-2">
          {{ $t(LISTWISE_SIZES.find(s => s.value === form.listwiseSize)?.hintKey ?? 'annotate.groupSize.hint4') }}
        </p>

        <label class="mt-4 flex gap-3 cursor-pointer items-start">
          <PSwitch v-model="form.listwiseRetest" size="sm" class="mt-0.5 shrink-0" :aria-labelledby="`${ids}-retest`" :aria-describedby="`${ids}-retest-hint`" />
          <span class="min-w-0">
            <span :id="`${ids}-retest`" class="text-sm text-fg">{{ $t('annotate.groupSize.retest') }}</span>
            <span :id="`${ids}-retest-hint`" class="text-xs text-fg-subtle leading-relaxed mt-0.5 block">
              {{ $t('annotate.groupSize.retestHint') }}
            </span>
          </span>
        </label>
      </section>

      <!-- 维度 chips（仅单图评分）：多选，toggle 按钮 -->
      <section v-if="form.kind === 'absolute'" class="mb-7">
        <div :id="`${ids}-dims`" class="annotate-section-title">
          {{ $t('annotate.dimensions.title') }}
          <span class="annotate-section-note">{{ $t('annotate.dimensions.note') }}</span>
        </div>
        <div role="group" :aria-labelledby="`${ids}-dims`" class="flex flex-wrap gap-2">
          <button
            v-for="d in DIMENSIONS"
            :key="d.key"
            type="button"
            class="annotate-dim-chip"
            :class="{ 'annotate-dim-chip--active': form.dimensions.includes(d.key) }"
            :aria-pressed="form.dimensions.includes(d.key)"
            @click="toggleDimension(d.key)"
          >
            <i :class="d.icon" class="text-base shrink-0" aria-hidden="true" />
            <span class="font-medium">{{ $t(d.labelKey) }}</span>
            <span class="annotate-dim-chip__hint">{{ $t(d.hintKey) }}</span>
          </button>
        </div>
      </section>

      <!-- 档位 / 采样：segmented -->
      <section v-if="form.kind === 'absolute'" class="mb-7 flex flex-wrap gap-x-10 gap-y-5">
        <div>
          <div :id="`${ids}-scale`" class="annotate-section-title">
            {{ $t('annotate.scale.title') }}
          </div>
          <div ref="scaleGroup" role="radiogroup" :aria-labelledby="`${ids}-scale`" class="annotate-segment">
            <button
              v-for="s in SCALES"
              :key="s.value"
              type="button"
              role="radio"
              :aria-checked="form.scale === s.value"
              class="annotate-segment__item"
              :class="{ 'annotate-segment__item--active': form.scale === s.value }"
              :title="$t(s.hintKey)"
              @click="form.scale = s.value"
            >
              {{ $t(s.labelKey) }}
            </button>
          </div>
        </div>
        <div>
          <div :id="`${ids}-sampling`" class="annotate-section-title">
            {{ $t('annotate.sampling.title') }}
          </div>
          <div ref="samplingGroup" role="radiogroup" :aria-labelledby="`${ids}-sampling`" class="annotate-segment">
            <button
              v-for="s in STRATEGIES"
              :key="s.value"
              type="button"
              role="radio"
              :aria-checked="form.strategy === s.value"
              class="annotate-segment__item"
              :class="{ 'annotate-segment__item--active': form.strategy === s.value }"
              :title="$t(s.hintKey)"
              @click="form.strategy = s.value"
            >
              {{ $t(s.labelKey) }}
            </button>
          </div>
        </div>
      </section>

      <!-- CTA -->
      <PButton ref="startButton" variant="primary" size="lg" block :disabled="!canStart" @click="startStream">
        <i class="i-tabler-player-play" aria-hidden="true" />
        {{ $t('annotate.start') }}
      </PButton>
      <i18n-t keypath="annotate.startHint" tag="p" scope="global" class="text-xs text-fg-subtle mt-2.5 text-center">
        <template #esc>
          <kbd class="annotate-kbd">Esc</kbd>
        </template>
        <template #space>
          <kbd class="annotate-kbd">Space</kbd>
        </template>
      </i18n-t>

      <!-- 队列：固定批次工具 -->
      <section class="mt-10">
        <button
          type="button"
          class="text-xs text-fg-muted py-1 flex gap-1 transition-colors items-center hover:text-fg"
          :aria-expanded="showQueues"
          :aria-controls="`${ids}-queues`"
          @click="showQueues = !showQueues"
        >
          <i :class="showQueues ? 'i-tabler-chevron-down' : 'i-tabler-chevron-right'" aria-hidden="true" />
          {{ $t('annotate.queue.toggle') }}
          <span class="text-fg-subtle">{{ $t('annotate.queue.toggleNote') }}</span>
        </button>

        <div v-if="showQueues" :id="`${ids}-queues`" class="mt-3 flex flex-col gap-3">
          <div class="text-xs flex gap-2.5 items-center">
            <input
              v-model.number="queueCount"
              type="number"
              min="1"
              max="5000"
              class="annotate-input w-24"
              :aria-label="$t('annotate.queue.count')"
              :title="$t('annotate.queue.count')"
            >
            <PButton size="sm" variant="subtle" :loading="generating" :disabled="!canStart" @click="generateQueue">
              {{ $t('annotate.queue.generate') }}
            </PButton>
          </div>

          <div v-if="!queues?.length" class="text-xs text-fg-subtle">
            {{ $t('annotate.queue.empty') }}
          </div>
          <button
            v-for="q in queues"
            :key="q.id"
            type="button"
            class="annotate-queue-row"
            @click="session = { mode: 'queue', queue: q }"
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">
                {{ q.name }}
              </div>
              <div class="text-xs text-fg-muted mt-0.5">
                {{ $t(KIND_LABEL_KEYS[q.kind]) }} · {{ q.dimensions.map(dimensionLabel).join(' / ') }}<template v-if="q.scale">
                  · {{ $t('annotate.scale.levels', { n: q.scale }) }}
                </template>
              </div>
              <div class="annotate-progress mt-2" aria-hidden="true">
                <div class="annotate-progress__bar" :style="{ width: `${q.total ? (q.done / q.total) * 100 : 0}%` }" />
              </div>
            </div>
            <div class="text-xs text-fg-muted shrink-0 tabular-nums">
              {{ formatNumber(q.done) }} / {{ formatNumber(q.total) }}
            </div>
          </button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.annotate-section-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 11px;
  font-weight: var(--p-weight-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--p-fg-subtle);
}
.annotate-section-note {
  font-weight: normal;
  letter-spacing: normal;
  text-transform: none;
  color: var(--p-fg-subtle);
}

/* 模式卡片 */
.annotate-mode-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 14px;
  text-align: left;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-lg);
  background: var(--p-surface-1);
  color: var(--p-fg-muted);
  cursor: pointer;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast),
    color var(--p-transition-fast);
}
.annotate-mode-card:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
}
.annotate-mode-card--active {
  color: var(--p-fg);
  border-color: rgb(var(--p-primary-rgb) / 0.8);
  background: rgb(var(--p-primary-rgb) / 0.08);
}
.annotate-mode-card--active i {
  color: var(--p-primary);
}

/* 维度 chips */
.annotate-dim-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 13px;
  font-size: var(--p-text-sm);
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-full);
  color: var(--p-fg-muted);
  background: transparent;
  cursor: pointer;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast),
    color var(--p-transition-fast);
}
.annotate-dim-chip:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
  color: var(--p-fg);
}
.annotate-dim-chip--active {
  color: var(--p-fg);
  border-color: rgb(var(--p-primary-rgb) / 0.8);
  background: rgb(var(--p-primary-rgb) / 0.12);
}
.annotate-dim-chip--active i {
  color: var(--p-primary);
}
.annotate-dim-chip__hint {
  font-size: var(--p-text-xs);
  color: var(--p-fg-subtle);
}

/* segmented control */
.annotate-segment {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-md);
  background: var(--p-surface-1);
}
.annotate-segment__item {
  padding: 6px 14px;
  font-size: var(--p-text-sm);
  border-radius: calc(var(--p-radius-md) - 3px);
  color: var(--p-fg-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  transition:
    background-color var(--p-transition-fast),
    color var(--p-transition-fast);
}
.annotate-segment__item:hover {
  color: var(--p-fg);
}
.annotate-segment__item--active {
  color: var(--p-fg);
  background: rgb(var(--p-primary-rgb) / 0.22);
}

/* misc */
.annotate-kbd {
  display: inline-block;
  padding: 1px 6px;
  font-family: var(--p-font-mono);
  font-size: 11px;
  border: 1px solid var(--p-border);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: var(--p-fg-muted);
}
.annotate-input {
  padding: 6px 10px;
  font-size: var(--p-text-sm);
  color: var(--p-fg);
  background: transparent;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-sm);
  transition: border-color var(--p-transition-fast);
}
.annotate-input:focus {
  border-color: rgb(var(--p-primary-rgb) / 0.7);
}
.annotate-queue-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  border: 1px solid var(--p-border);
  border-radius: var(--p-radius-lg);
  background: transparent;
  color: var(--p-fg);
  cursor: pointer;
  transition:
    border-color var(--p-transition-fast),
    background-color var(--p-transition-fast);
}
.annotate-queue-row:hover {
  border-color: rgb(var(--p-primary-rgb) / 0.45);
  background: rgb(var(--p-primary-rgb) / 0.05);
}
.annotate-progress {
  height: 3px;
  border-radius: var(--p-radius-full);
  background: var(--p-surface-3);
  overflow: hidden;
}
.annotate-progress__bar {
  height: 100%;
  border-radius: inherit;
  background: var(--p-primary);
  transition: width var(--p-transition-fast);
}
</style>
