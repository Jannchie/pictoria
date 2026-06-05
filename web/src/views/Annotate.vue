<script setup lang="ts">
import type { QueueSummaryPublic } from '@/api'
import type { StreamConfig } from '@/components/annotate/AbsoluteAnnotationSession.vue'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { v2GenerateAbsolute, v2GeneratePairwise, v2ListQueues } from '@/api'
import AbsoluteAnnotationSession from '@/components/annotate/AbsoluteAnnotationSession.vue'
import PairwiseAnnotationSession from '@/components/annotate/PairwiseAnnotationSession.vue'
import { useAPIError } from '@/composables/useAPIError'

const { handle: handleAPIError } = useAPIError()

type Session
  = | { mode: 'queue', queue: QueueSummaryPublic }
    | { mode: 'stream-absolute', config: StreamConfig }
    | { mode: 'stream-pairwise', dimension: string }

const session = ref<Session | null>(null)

const { data: queues, refetch } = useQuery({
  queryKey: ['annotation-queues'],
  queryFn: async () => {
    const resp = await v2ListQueues()
    return resp.data ?? []
  },
})

function exitSession() {
  session.value = null
  refetch()
}

// ── 标注配置（流式为默认路径，队列仅用于固定批次实验）────────────
interface DimensionMeta {
  key: string
  label: string
  hint: string
  icon: string
}
const DIMENSIONS: DimensionMeta[] = [
  { key: 'color', label: '颜色', hint: '配色运用得好吗', icon: 'i-tabler-palette' },
  { key: 'finish', label: '完成度', hint: '精修 / 装饰精致吗', icon: 'i-tabler-brush' },
  { key: 'composition', label: '构图', hint: '姿势·角度·布景有想法吗', icon: 'i-tabler-layout-collage' },
  { key: 'overall', label: '总分', hint: '总体喜欢吗', icon: 'i-tabler-star' },
]

const form = ref({
  kind: 'absolute' as 'absolute' | 'pairwise',
  dimensions: ['color'] as string[],
  scale: 2,
  strategy: 'stratified' as 'random' | 'stratified',
})
const canStart = computed(() => form.value.dimensions.length > 0)

function toggleDimension(d: string) {
  if (form.value.kind === 'pairwise') {
    form.value.dimensions = [d] // 对比模式一次一个维度
    return
  }
  const dims = form.value.dimensions
  form.value.dimensions = dims.includes(d) ? dims.filter(x => x !== d) : [...dims, d]
}

watch(() => form.value.kind, (kind) => {
  if (kind === 'pairwise' && form.value.dimensions.length > 1) {
    form.value.dimensions = form.value.dimensions.slice(0, 1)
  }
})

const SCALES = [
  { value: 2, label: '二元', hint: '好 / 不好' },
  { value: 3, label: '三元', hint: '差 / 中 / 好' },
  { value: 5, label: '五级', hint: '1 – 5' },
]
const STRATEGIES = [
  { value: 'stratified' as const, label: '按旧分分层', hint: '1–5 分各层均匀' },
  { value: 'random' as const, label: '随机', hint: '全库均匀' },
]

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
    : { mode: 'stream-pairwise', dimension: form.value.dimensions[0] ?? 'color' }
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
      : v2GeneratePairwise({
          body: { dimension: form.value.dimensions[0] ?? 'color', count: queueCount.value },
        }))
    await refetch()
  }
  catch (error) {
    handleAPIError(error, '生成队列失败')
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
    <AbsoluteAnnotationSession
      v-else-if="session?.mode === 'stream-absolute'"
      :config="session.config"
      @exit="exitSession"
    />
    <PairwiseAnnotationSession
      v-else-if="session?.mode === 'stream-pairwise'"
      :dimension="session.dimension"
      @exit="exitSession"
    />

    <div v-else class="mx-auto px-6 pb-16 pt-10 max-w-xl">
      <!-- 页头 -->
      <header class="mb-8">
        <h1 class="text-2xl text-fg tracking-tight font-semibold">
          标注
        </h1>
        <p class="text-sm text-fg-muted leading-relaxed mt-1.5">
          打开即标——系统按策略抓取未标注的图，标完一张自动出下一张。
        </p>
      </header>

      <!-- 模式：两张可选卡片 -->
      <section class="mb-7">
        <div class="annotate-section-title">
          模式
        </div>
        <div class="gap-2.5 grid grid-cols-2">
          <button
            class="annotate-mode-card"
            :class="{ 'annotate-mode-card--active': form.kind === 'absolute' }"
            @click="form.kind = 'absolute'"
          >
            <i class="i-tabler-photo text-lg" />
            <div class="min-w-0">
              <div class="text-sm font-medium">
                单图评分
              </div>
              <div class="text-xs text-fg-muted mt-0.5">
                一张图标完所有勾选维度
              </div>
            </div>
          </button>
          <button
            class="annotate-mode-card"
            :class="{ 'annotate-mode-card--active': form.kind === 'pairwise' }"
            @click="form.kind = 'pairwise'"
          >
            <i class="i-tabler-layout-columns text-lg" />
            <div class="min-w-0">
              <div class="text-sm font-medium">
                双图对比
              </div>
              <div class="text-xs text-fg-muted mt-0.5">
                两张图选更好的一边，抗光环效应
              </div>
            </div>
          </button>
        </div>
      </section>

      <!-- 维度 chips -->
      <section class="mb-7">
        <div class="annotate-section-title">
          维度
          <span v-if="form.kind === 'pairwise'" class="annotate-section-note">对比模式一次只问一个维度</span>
          <span v-else class="annotate-section-note">建议单维轮标，判断更纯更快</span>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="d in DIMENSIONS"
            :key="d.key"
            class="annotate-dim-chip"
            :class="{ 'annotate-dim-chip--active': form.dimensions.includes(d.key) }"
            @click="toggleDimension(d.key)"
          >
            <i :class="d.icon" class="text-base shrink-0" />
            <span class="font-medium">{{ d.label }}</span>
            <span class="annotate-dim-chip__hint">{{ d.hint }}</span>
          </button>
        </div>
      </section>

      <!-- 档位 / 采样：segmented -->
      <section v-if="form.kind === 'absolute'" class="mb-7 flex flex-wrap gap-x-10 gap-y-5">
        <div>
          <div class="annotate-section-title">
            档位
          </div>
          <div class="annotate-segment">
            <button
              v-for="s in SCALES"
              :key="s.value"
              class="annotate-segment__item"
              :class="{ 'annotate-segment__item--active': form.scale === s.value }"
              :title="s.hint"
              @click="form.scale = s.value"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
        <div>
          <div class="annotate-section-title">
            采样
          </div>
          <div class="annotate-segment">
            <button
              v-for="s in STRATEGIES"
              :key="s.value"
              class="annotate-segment__item"
              :class="{ 'annotate-segment__item--active': form.strategy === s.value }"
              :title="s.hint"
              @click="form.strategy = s.value"
            >
              {{ s.label }}
            </button>
          </div>
        </div>
      </section>

      <!-- CTA -->
      <PButton variant="primary" size="lg" block :disabled="!canStart" @click="startStream">
        <i class="i-tabler-player-play" />
        开始标注
      </PButton>
      <p class="text-xs text-fg-subtle mt-2.5 text-center">
        全键盘操作 · <kbd class="annotate-kbd">Esc</kbd> 随时退出 · <kbd class="annotate-kbd">Space</kbd> 跳过
      </p>

      <!-- 队列：固定批次工具 -->
      <section class="mt-10">
        <button
          class="text-xs text-fg-muted py-1 flex gap-1 transition-colors items-center hover:text-fg"
          @click="showQueues = !showQueues"
        >
          <i :class="showQueues ? 'i-tabler-chevron-down' : 'i-tabler-chevron-right'" />
          固定批次队列
          <span class="text-fg-subtle">— 形态对比实验 / 复测用</span>
        </button>

        <div v-if="showQueues" class="mt-3 flex flex-col gap-3">
          <div class="text-xs flex gap-2.5 items-center">
            <input
              v-model.number="queueCount"
              type="number"
              min="1"
              max="5000"
              class="annotate-input w-24"
            >
            <PButton size="sm" variant="subtle" :loading="generating" :disabled="!canStart" @click="generateQueue">
              按上面配置生成队列
            </PButton>
          </div>

          <div v-if="!queues?.length" class="text-xs text-fg-subtle">
            暂无队列。
          </div>
          <button
            v-for="q in queues"
            :key="q.id"
            class="annotate-queue-row"
            @click="session = { mode: 'queue', queue: q }"
          >
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">
                {{ q.name }}
              </div>
              <div class="text-xs text-fg-muted mt-0.5">
                {{ q.kind === 'absolute' ? '单图评分' : '双图对比' }} · {{ q.dimensions.join(' / ') }}<template v-if="q.scale">
                  · {{ q.scale }} 级
                </template>
              </div>
              <div class="annotate-progress mt-2">
                <div class="annotate-progress__bar" :style="{ width: `${q.total ? (q.done / q.total) * 100 : 0}%` }" />
              </div>
            </div>
            <div class="text-xs text-fg-muted shrink-0 tabular-nums">
              {{ q.done }} / {{ q.total }}
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
  font-weight: var(--p-weight-semibold, 600);
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
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-lg);
  background: var(--p-surface-1, transparent);
  color: var(--p-fg-muted);
  cursor: pointer;
  transition:
    border-color var(--p-duration-fast) var(--p-ease),
    background-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease);
}
.annotate-mode-card:hover {
  border-color: rgb(var(--p-brand-500-rgb) / 0.45);
}
.annotate-mode-card--active {
  color: var(--p-fg);
  border-color: rgb(var(--p-brand-500-rgb) / 0.8);
  background: rgb(var(--p-brand-500-rgb) / 0.08);
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
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-full);
  color: var(--p-fg-muted);
  background: transparent;
  cursor: pointer;
  transition:
    border-color var(--p-duration-fast) var(--p-ease),
    background-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease);
}
.annotate-dim-chip:hover {
  border-color: rgb(var(--p-brand-500-rgb) / 0.45);
  color: var(--p-fg);
}
.annotate-dim-chip--active {
  color: var(--p-fg);
  border-color: rgb(var(--p-brand-500-rgb) / 0.8);
  background: rgb(var(--p-brand-500-rgb) / 0.12);
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
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-md);
  background: var(--p-surface-1, transparent);
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
    background-color var(--p-duration-fast) var(--p-ease),
    color var(--p-duration-fast) var(--p-ease);
}
.annotate-segment__item:hover {
  color: var(--p-fg);
}
.annotate-segment__item--active {
  color: var(--p-fg);
  background: rgb(var(--p-brand-500-rgb) / 0.22);
}

/* misc */
.annotate-kbd {
  display: inline-block;
  padding: 1px 6px;
  font-family: var(--p-font-mono);
  font-size: 11px;
  border: 1px solid var(--p-border-default);
  border-bottom-width: 2px;
  border-radius: var(--p-radius-xs);
  color: var(--p-fg-muted);
}
.annotate-input {
  padding: 6px 10px;
  font-size: var(--p-text-sm);
  color: var(--p-fg);
  background: transparent;
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-sm);
  transition: border-color var(--p-duration-fast) var(--p-ease);
}
.annotate-input:focus {
  outline: none;
  border-color: rgb(var(--p-brand-500-rgb) / 0.7);
}
.annotate-queue-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 12px 14px;
  text-align: left;
  border: 1px solid var(--p-border-default);
  border-radius: var(--p-radius-lg);
  background: transparent;
  color: var(--p-fg);
  cursor: pointer;
  transition:
    border-color var(--p-duration-fast) var(--p-ease),
    background-color var(--p-duration-fast) var(--p-ease);
}
.annotate-queue-row:hover {
  border-color: rgb(var(--p-brand-500-rgb) / 0.45);
  background: rgb(var(--p-brand-500-rgb) / 0.05);
}
.annotate-progress {
  height: 3px;
  border-radius: var(--p-radius-full);
  background: var(--p-surface-3, rgb(255 255 255 / 0.08));
  overflow: hidden;
}
.annotate-progress__bar {
  height: 100%;
  border-radius: inherit;
  background: var(--p-primary);
  transition: width var(--p-duration-fast) var(--p-ease);
}
</style>
