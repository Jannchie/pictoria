<script setup lang="ts">
import type { QueueSummaryPublic } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { v2GenerateAbsolute, v2GeneratePairwise, v2ListQueues } from '@/api'
import AbsoluteAnnotationSession from '@/components/annotate/AbsoluteAnnotationSession.vue'
import PairwiseAnnotationSession from '@/components/annotate/PairwiseAnnotationSession.vue'
import { useAPIError } from '@/composables/useAPIError'

const { handle: handleAPIError } = useAPIError()

const activeQueue = ref<QueueSummaryPublic | null>(null)

const { data: queues, refetch } = useQuery({
  queryKey: ['annotation-queues'],
  queryFn: async () => {
    const resp = await v2ListQueues()
    return resp.data ?? []
  },
})

function exitSession() {
  activeQueue.value = null
  refetch()
}

// ── 新建队列表单 ──────────────────────────────────────────────
const ALL_DIMENSIONS = ['color', 'finish', 'composition', 'overall']
const form = ref({
  kind: 'absolute' as 'absolute' | 'pairwise',
  dimensions: ['color', 'finish', 'composition'] as string[],
  scale: 2,
  count: 100,
  strategy: 'stratified' as 'random' | 'stratified',
})
const generating = ref(false)
const canGenerate = computed(() =>
  form.value.count > 0
  && (form.value.kind === 'pairwise' || form.value.dimensions.length > 0),
)

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

async function generateQueue() {
  if (!canGenerate.value || generating.value) {
    return
  }
  generating.value = true
  try {
    await (form.value.kind === 'absolute'
      ? v2GenerateAbsolute({
          body: {
            dimensions: ALL_DIMENSIONS.filter(d => form.value.dimensions.includes(d)),
            scale: form.value.scale,
            count: form.value.count,
            strategy: form.value.strategy,
          },
        })
      : v2GeneratePairwise({
          body: { dimension: form.value.dimensions[0] ?? 'color', count: form.value.count },
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
      v-if="activeQueue && activeQueue.kind === 'absolute'"
      :queue="activeQueue"
      @exit="exitSession"
    />
    <PairwiseAnnotationSession
      v-else-if="activeQueue && activeQueue.kind === 'pairwise'"
      :queue="activeQueue"
      @exit="exitSession"
    />
    <div v-else class="mx-auto p-6 max-w-2xl">
      <h1 class="text-lg font-medium mb-4">
        标注队列
      </h1>

      <!-- 新建队列 -->
      <div class="mb-6 p-3 p-border rounded-md flex flex-col gap-3">
        <div class="text-sm font-medium">
          新建队列
        </div>
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
        <div class="text-xs flex gap-3 items-center">
          <span class="text-fg-subtle w-12">数量</span>
          <input
            v-model.number="form.count"
            type="number"
            min="1"
            max="5000"
            class="px-2 py-1 p-border rounded bg-bg w-24"
          >
          <template v-if="form.kind === 'absolute'">
            <span class="text-fg-subtle">策略</span>
            <label class="flex gap-1 items-center"><input v-model="form.strategy" type="radio" value="stratified">按旧分分层</label>
            <label class="flex gap-1 items-center"><input v-model="form.strategy" type="radio" value="random">随机</label>
          </template>
        </div>
        <div>
          <PButton size="sm" :loading="generating" :disabled="!canGenerate" @click="generateQueue">
            {{ generating ? '生成中…' : '生成队列' }}
          </PButton>
        </div>
      </div>

      <!-- 队列列表 -->
      <div v-if="!queues?.length" class="text-sm text-fg-muted">
        暂无队列，用上面的表单生成一个。
      </div>
      <button
        v-for="q in queues"
        :key="q.id"
        class="mb-2 p-3 text-left p-border rounded-md flex gap-2 w-full items-center justify-between hover:bg-surface"
        @click="activeQueue = q"
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
</template>
