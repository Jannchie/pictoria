<script setup lang="ts">
import type { PostSimplePublic } from '@/api'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatNumber } from '@/locale'
import { ratingName, ratingVisual, SCORE_ICON } from '@/shared'

// Stand-in for PostDetailPanel while the selected post's detail request is in
// flight. The gallery row already carries the name, size, rating and score, so
// those show at once (no flash back to the gallery overview between a click and
// the response); only the tags — which the row doesn't have — are a skeleton.
const props = defineProps<{
  post: PostSimplePublic
}>()

const { t } = useI18n()

const fileName = computed(() => `${props.post.fileName}.${props.post.extension}`)
const ratingText = computed(() => ratingName(props.post.rating, t))
const rating = computed(() => ratingVisual(props.post.rating))

// Fixed widths: a skeleton that changes shape on every render reads as noise.
const TAG_WIDTHS = [64, 88, 48, 72, 56, 96, 40, 68]
</script>

<template>
  <div class="text-xs px-3 flex flex-col h-full" aria-busy="true">
    <div class="pb-3 pt-3 p-divider flex flex-col gap-1">
      <h2 class="text-sm text-fg font-medium truncate" :title="fileName">
        {{ fileName }}
      </h2>
      <div class="text-fg-subtle flex gap-2 items-center">
        <span v-if="post.width && post.height" class="tabular-nums">
          {{ formatNumber(post.width) }} × {{ formatNumber(post.height) }}
        </span>
        <span class="uppercase">{{ post.extension }}</span>
      </div>
    </div>
    <section class="py-3 p-divider">
      <h3 class="p-section-title mb-2">
        <i :class="SCORE_ICON" aria-hidden="true" />
        <span>{{ $t('post.ratings') }}</span>
      </h3>
      <div class="gap-y-1 p-kv-grid items-center odd:children:text-fg-muted">
        <div>{{ $t('post.ratingLabel') }}</div>
        <div class="flex gap-1.5 items-center">
          <i :class="rating.icon" :style="rating.color ? { color: rating.color } : undefined" aria-hidden="true" />
          <span>{{ ratingText }}</span>
        </div>
        <div>{{ $t('post.scoreLabel') }}</div>
        <div class="tabular-nums">
          {{ post.score >= 1 ? $t('filter.star', { n: post.score }, post.score) : $t('common.unscored') }}
        </div>
      </div>
    </section>
    <section class="py-3">
      <h3 class="p-section-title mb-2">
        <i class="i-tabler-tags" aria-hidden="true" />
        <span>{{ $t('post.tags') }}</span>
      </h3>
      <div class="flex flex-wrap gap-1.5" role="status" :aria-label="$t('post.panel.loadingDetail')">
        <span
          v-for="(w, i) in TAG_WIDTHS"
          :key="i"
          class="rounded-sm h-5 p-skeleton"
          :style="{ 'width': `${w}px`, '--i': i }"
        />
      </div>
    </section>
  </div>
</template>
