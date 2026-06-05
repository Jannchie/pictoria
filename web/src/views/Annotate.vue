<script setup lang="ts">
import type { QueueSummaryPublic } from '@/api'
import { useQuery } from '@tanstack/vue-query'
import { ref } from 'vue'
import { v2ListQueues } from '@/api'
import AbsoluteAnnotationSession from '@/components/annotate/AbsoluteAnnotationSession.vue'
import PairwiseAnnotationSession from '@/components/annotate/PairwiseAnnotationSession.vue'

const activeQueue = ref<QueueSummaryPublic | null>(null)

const { data: queues, refetch } = useQuery({
  queryKey: ['annotation-queues'],
  queryFn: async () => (await v2ListQueues()).data ?? [],
})

function exitSession() {
  activeQueue.value = null
  refetch()
}
</script>

<template>
  <div class="h-full bg-bg text-fg">
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
    <div v-else class="mx-auto max-w-2xl p-6">
      <h1 class="text-lg font-medium mb-4">标注队列</h1>
      <div v-if="!queues?.length" class="text-fg-muted text-sm">
        暂无队列。用 silva 侧脚本生成并 POST /v2/annotation-queues/absolute 导入。
      </div>
      <button
        v-for="q in queues"
        :key="q.id"
        class="w-full p-border rounded-md p-3 mb-2 flex gap-2 items-center justify-between text-left hover:bg-surface"
        @click="activeQueue = q"
      >
        <div>
          <div class="text-sm font-medium">{{ q.name }}</div>
          <div class="text-xs text-fg-muted">
            {{ q.kind }} · {{ q.dimensions.join(' / ') }}<template v-if="q.scale"> · {{ q.scale }} 级</template>
          </div>
        </div>
        <div class="text-xs text-fg-muted">{{ q.done }} / {{ q.total }}</div>
      </button>
    </div>
  </div>
</template>
