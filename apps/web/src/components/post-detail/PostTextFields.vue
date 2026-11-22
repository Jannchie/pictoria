<script setup lang="ts">
import type { PostDetailPublic, PostSimplePublic } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAPIError } from '@/composables/useAPIError'
import { useTextField } from '@/composables/useTextField'
import { commitCaption, commitSource } from '@/shared'
import { isMac } from '@/utils/keyboard'

// The post detail panel's caption and source fields. Like the panel, the post
// is either the detail or the gallery row standing in for it; the fields stay
// disabled until the detail is in.
const props = defineProps<{
  post: PostDetailPublic | PostSimplePublic
}>()

const { t } = useI18n()
const queryClient = useQueryClient()
const { handle: handleAPIError } = useAPIError()
// `tags` is detail-only: the discriminant between the two shapes.
const detail = computed(() => 'tags' in props.post ? props.post : undefined)

const caption = useTextField({
  postId: () => props.post.id,
  read: () => detail.value?.caption ?? '',
  ready: () => detail.value !== undefined,
  commit: (id, o, n) => commitCaption(queryClient, id, o, n),
  onError: error => handleAPIError(error, t('error.captionFailed')),
})
const source = useTextField({
  postId: () => props.post.id,
  read: () => detail.value?.source ?? '',
  ready: () => detail.value !== undefined,
  commit: (id, o, n) => commitSource(queryClient, id, o, n),
  onError: error => handleAPIError(error, t('error.sourceFailed')),
})
const captionDraft = caption.draft
const captionInvalid = caption.invalid
const sourceDraft = source.draft
const sourceInvalid = source.invalid
function onCaptionKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey) && !e.isComposing) {
    e.preventDefault()
    caption.save()
  }
}
function onSourceKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    source.save()
  }
}

const captionHintId = `${useId()}-caption-hint`
</script>

<template>
  <!-- Caption -->
  <PDisclosure
    storage-key="post.caption"
    icon="i-tabler-blockquote"
    :title="$t('post.caption')"
    :default-open="false"
  >
    <PTextarea
      v-model="captionDraft"
      :aria-label="$t('post.caption')"
      :aria-describedby="captionHintId"
      :invalid="captionInvalid"
      :disabled="!detail"
      size="sm"
      :max-rows="10"
      @focus="caption.onFocus"
      @blur="caption.save"
      @keydown="onCaptionKeydown"
    />
    <div :id="captionHintId" class="text-2xs text-fg-subtle mt-1">
      {{ $t('post.panel.captionHint', { shortcut: isMac ? '⌘ Enter' : 'Ctrl+Enter' }) }}
    </div>
  </PDisclosure>

  <!-- Source -->
  <PDisclosure
    storage-key="post.source"
    icon="i-tabler-link"
    :title="$t('post.source')"
    :default-open="false"
  >
    <PInput
      :model-value="sourceDraft"
      :aria-label="$t('post.source')"
      :invalid="sourceInvalid"
      :disabled="!detail"
      size="sm"
      block
      @update:model-value="(v) => sourceDraft = String(v ?? '')"
      @focus="source.onFocus"
      @blur="source.save"
      @keydown="onSourceKeydown"
    />
  </PDisclosure>
</template>
