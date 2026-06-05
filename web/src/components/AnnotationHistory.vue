<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { v2PostHistory } from '@/api'

const props = defineProps<{ postId: number }>()

const { data } = useQuery({
  queryKey: ['annotations', () => props.postId],
  queryFn: async () => {
    const resp = await v2PostHistory({ path: { post_id: props.postId } })
    return resp.data
  },
})

const hasAny = computed(() =>
  (data.value?.absolute?.length ?? 0) > 0
  || (data.value?.pairwise?.length ?? 0) > 0
  || Boolean(data.value?.contentFlag),
)

const sectionTitleClass
  = 'flex items-center gap-1.5 text-fg-subtle text-[11px] font-semibold uppercase tracking-wider'
</script>

<template>
  <section v-if="hasAny" class="py-4">
    <div :class="sectionTitleClass" class="mb-2">
      <i class="i-tabler-tags" />
      <span>{{ $t('post.annotationHistory') }}</span>
    </div>
    <div class="text-xs flex flex-col gap-1">
      <div v-if="data?.contentFlag">
        {{ data.contentFlag === 'love' ? '❤️' : '💢' }} {{ data.contentFlag }}
      </div>
      <div v-for="a in data?.absolute" :key="`abs-${a.id}`" class="text-fg-muted flex justify-between">
        <span>{{ a.dimension }} = {{ a.value }}/{{ a.scale }}</span>
        <span>{{ a.createdAt.slice(0, 10) }}</span>
      </div>
      <div v-for="p in data?.pairwise" :key="`pw-${p.id}`" class="text-fg-muted flex justify-between">
        <span>{{ p.dimension }}: #{{ p.postA }} vs #{{ p.postB }} → {{ p.winner }}</span>
        <span>{{ p.createdAt.slice(0, 10) }}</span>
      </div>
    </div>
  </section>
</template>
