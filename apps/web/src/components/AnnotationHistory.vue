<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { computed } from 'vue'
import { flagGlyph, winnerLabel } from '@/shared'
import { postAnnotationsQueryOptions } from '@/shared/postQueries'

const props = defineProps<{ postId: number }>()

const { data } = useQuery(postAnnotationsQueryOptions(computed(() => props.postId)))

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
    <h3 :class="sectionTitleClass" class="mb-2">
      <i class="i-tabler-tags" aria-hidden="true" />
      <span>{{ $t('post.annotationHistory') }}</span>
    </h3>
    <div class="text-xs flex flex-col gap-1">
      <div v-if="data?.contentFlag">
        {{ flagGlyph(data.contentFlag) }} {{ data.contentFlag }}
      </div>
      <div v-for="a in data?.absolute" :key="`abs-${a.id}`" class="text-fg-muted flex justify-between">
        <span>{{ a.dimension }} = {{ a.value }}/{{ a.scale }}</span>
        <time :datetime="a.createdAt">{{ a.createdAt.slice(0, 10) }}</time>
      </div>
      <div v-for="p in data?.pairwise" :key="`pw-${p.id}`" class="text-fg-muted flex justify-between">
        <span>{{ p.dimension }}: #{{ p.postA }} vs #{{ p.postB }} → {{ winnerLabel(p.winner) }}</span>
        <time :datetime="p.createdAt">{{ p.createdAt.slice(0, 10) }}</time>
      </div>
    </div>
  </section>
</template>
