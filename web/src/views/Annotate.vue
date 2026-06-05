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
const ALL_DIMENSIONS = ['color', 'finish', 'composition', 'overall']
const form = ref({
  kind: 'absolute' as 'absolute' | 'pairwise',
  dimensions: ['color', 'finish', 'composition'] as string[],
  scale: 2,
  strategy: 'stratified' as 'random' | 'stratified',
})
const canStart = computed(() => form.value.kind === 'pairwise' || form.value.dimensions.length > 0)

function toggleDimension(d: string) {
  const dims = form.value.dimensions
  form.value.dimensions = dims.includes(d) ? dims.filter(x => x !== d) : [...dims, d]
}

// 对比模式一次只问一个维度
watch(() => form.value.kind, (kind) => {
  if (kind === 'pairwise' && form.value.dimensions.length > 1) {
    form.value.dimensions = form.value.dimensions.slice(0, 1)
  }
})

function startStream() {
  if (!canStart.value) {
    return
  }
  session.value = form.value.kind === 'absolute'
    ? {
        mode: 'stream-absolute',
        config: {
          dimensions: ALL_DIMENSIONS.filter(d => form.value.dimensions.includes(d)),
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
            dimensions: ALL_DIMENSIONS.filter(d => form.value.dimensions.includes(d)),
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
  <div class="text-fg bg-bg h-full">
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

    <div v-else class="mx-auto p-6 max-w-2xl">
      <h1 class="text-lg font-medium mb-4">
        标注
      </h1>

      <!-- 标注配置 -->
      <div class="mb-6 p-3 p-border rounded-md flex flex-col gap-3">
        <div class="text-xs flex gap-3 items-center">
          <span class="text-fg-subtle w-12">类型</span>
          <label class="flex gap-1 items-center"><input v-model="form.kind" type="radio" value="absolute">单图多维</label>
          <label class="flex gap-1 items-center"><input v-model="form.kind" type="radio" value="pairwise">双图对比</label>
        </div>
        <div class="text-xs flex gap-3 items-center">
          <span class="text-fg-subtle w-12">维度</span>
          <label v-for="d in ALL_DIMENSIONS" :key="d" class="flex gap-1 items-center">
            <input
              type="checkbox"
              :checked="form.dimensions.includes(d)"
              :disabled="form.kind === 'pairwise' && !form.dimensions.includes(d) && form.dimensions.length > 0"
              @change="toggleDimension(d)"
            >{{ d }}
          </label>
          <span v-if="form.kind === 'pairwise'" class="text-fg-subtle">（对比模式一次一个维度）</span>
        </div>
        <div v-if="form.kind === 'absolute'" class="text-xs flex gap-3 items-center">
          <span class="text-fg-subtle w-12">档位</span>
          <label class="flex gap-1 items-center"><input v-model.number="form.scale" type="radio" :value="2">二元</label>
          <label class="flex gap-1 items-center"><input v-model.number="form.scale" type="radio" :value="3">三元</label>
          <label class="flex gap-1 items-center"><input v-model.number="form.scale" type="radio" :value="5">五级</label>
        </div>
        <div v-if="form.kind === 'absolute'" class="text-xs flex gap-3 items-center">
          <span class="text-fg-subtle w-12">采样</span>
          <label class="flex gap-1 items-center"><input v-model="form.strategy" type="radio" value="stratified">按旧分分层</label>
          <label class="flex gap-1 items-center"><input v-model="form.strategy" type="radio" value="random">随机</label>
        </div>
        <div>
          <PButton size="sm" :disabled="!canStart" @click="startStream">
            开始标注
          </PButton>
        </div>
      </div>

      <!-- 队列：固定批次工具（形态对比实验 / 复测） -->
      <button class="text-xs text-fg-muted mb-2 hover:text-fg" @click="showQueues = !showQueues">
        {{ showQueues ? '▾' : '▸' }} 固定批次队列（形态实验 / 复测用）
      </button>
      <div v-if="showQueues">
        <div class="text-xs mb-3 flex gap-3 items-center">
          <span class="text-fg-subtle">数量</span>
          <input
            v-model.number="queueCount"
            type="number"
            min="1"
            max="5000"
            class="px-2 py-1 p-border rounded bg-bg w-24"
          >
          <PButton size="sm" variant="subtle" :loading="generating" :disabled="!canStart" @click="generateQueue">
            {{ generating ? '生成中…' : '按上面配置生成队列' }}
          </PButton>
        </div>
        <div v-if="!queues?.length" class="text-xs text-fg-muted">
          暂无队列。
        </div>
        <button
          v-for="q in queues"
          :key="q.id"
          class="mb-2 p-3 text-left p-border rounded-md flex gap-2 w-full items-center justify-between hover:bg-surface"
          @click="session = { mode: 'queue', queue: q }"
        >
          <div>
            <div class="text-sm font-medium">
              {{ q.name }}
            </div>
            <div class="text-xs text-fg-muted">
              {{ q.kind }} · {{ q.dimensions.join(' / ') }}<template v-if="q.scale">
                · {{ q.scale }} 级
              </template>
            </div>
          </div>
          <div class="text-xs text-fg-muted">
            {{ q.done }} / {{ q.total }}
          </div>
        </button>
      </div>
    </div>
  </div>
</template>
