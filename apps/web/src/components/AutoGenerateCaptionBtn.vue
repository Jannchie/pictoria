<script setup lang="ts">
import { useMutation, useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2AutoCaption } from '@/api'
import { announce } from '@/shared/announce'
import { queryKeys } from '@/shared/queryKeys'

const props = defineProps<{
  postId: number
}>()
const id = computed(() => props.postId)
const { t } = useI18n()

const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: () => {
    return v2AutoCaption({ path: { post_id: id.value } })
  },
  onSuccess: () => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.postRoot(id),
    })
    // The result lands elsewhere in the panel; say that it did.
    announce(t('post.panel.autoCaptionDone'))
  },
  onError: () => {
    announce(t('post.panel.autoCaptionFailed'), 'assertive')
  },
})

// `click` (not pointerdown) so Enter / Space / assistive-tech clicks work;
// a second press while the request runs is ignored.
function onAutoTag() {
  if (mutation.isPending.value) {
    return
  }
  mutation.mutate()
}
</script>

<template>
  <PButton
    size="sm"
    block
    :aria-busy="mutation.isPending.value"
    @click="onAutoTag"
  >
    <i
      v-if="mutation.status.value === 'pending'"
      class="i-svg-spinners-90-ring-with-bg"
      aria-hidden="true"
    />
    <i
      v-else
      class="i-tabler-message-2-bolt"
      aria-hidden="true"
    />
    <div class="w-full text-nowrap text-ellipsis overflow-hidden">
      {{ $t('post.autoGenerateCaption') }}
    </div>
  </PButton>
</template>
