<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInFlight } from '@/composables/useInFlight'
import { announce } from '@/shared/announce'
import { autoCaptionPost, autoTagPost } from '@/shared/mutations'

type AutoGenerateKind = 'tag' | 'caption'

const props = defineProps<{
  kind: AutoGenerateKind
  postId: number
}>()
const { t } = useI18n()

const queryClient = useQueryClient()

const KINDS = {
  tag: {
    generate: autoTagPost,
    icon: 'i-tabler-photo-pentagon',
    labelKey: 'post.autoGenerateTag',
    doneKey: 'post.panel.autoTagsDone',
    failedKey: 'post.panel.autoTagsFailed',
  },
  caption: {
    generate: autoCaptionPost,
    icon: 'i-tabler-message-2-bolt',
    labelKey: 'post.autoGenerateCaption',
    doneKey: 'post.panel.autoCaptionDone',
    failedKey: 'post.panel.autoCaptionFailed',
  },
} as const satisfies Record<AutoGenerateKind, unknown>

const config = computed(() => KINDS[props.kind])

const inFlight = useInFlight<string>('autoGenerate')
const pending = computed(() => inFlight.has(`${props.kind}:${props.postId}`))

// `click` (not pointerdown) so Enter / Space / assistive-tech clicks work;
// a second press while the request for this post runs is ignored.
function onClick() {
  const { generate, doneKey, failedKey } = config.value
  const postId = props.postId
  return inFlight.run(`${props.kind}:${postId}`, async () => {
    try {
      await generate(queryClient, postId)
      // The result lands elsewhere in the panel; say that it did.
      announce(t(doneKey))
    }
    catch {
      announce(t(failedKey), 'assertive')
    }
  })
}
</script>

<template>
  <PButton
    size="sm"
    block
    :aria-busy="pending"
    @click="onClick"
  >
    <i
      v-if="pending"
      class="i-svg-spinners-90-ring-with-bg"
      aria-hidden="true"
    />
    <i
      v-else
      :class="config.icon"
      aria-hidden="true"
    />
    <div class="w-full text-nowrap text-ellipsis overflow-hidden">
      {{ $t(config.labelKey) }}
    </div>
  </PButton>
</template>
