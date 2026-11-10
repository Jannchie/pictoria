<script setup lang="ts">
import { formatNumber } from '@/locale'

// A session's "nothing left" screen. With zero judged this session it is not a
// success — the sampler simply came back empty — so it says that instead, and
// the actions point at the way out (another pairing / the launcher).
const props = defineProps<{
  kind: 'absolute' | 'pairwise' | 'listwise'
  done: number
}>()
const emit = defineEmits<{ home: [] }>()
const none = computed(() => props.done === 0)
</script>

<template>
  <PEmpty :icon="none ? 'i-tabler-mood-empty' : 'i-tabler-circle-check'">
    <span class="text-fg font-medium block">
      {{ $t(none ? `annotate.${kind}.none` : `annotate.${kind}.exhausted`) }}
    </span>
    <span class="text-xs text-fg-muted mt-1 block">
      {{ none ? $t('annotate.finished.noneHint') : $t(`annotate.${kind}.exhaustedDetail`, { n: formatNumber(done) }) }}
    </span>
    <template #action>
      <div class="mt-2 flex flex-wrap gap-2 justify-center">
        <slot />
        <PButton size="sm" :variant="$slots.default ? 'subtle' : 'primary'" @click="emit('home')">
          <i class="i-tabler-arrow-left" aria-hidden="true" />
          {{ $t('annotate.finished.home') }}
        </PButton>
      </div>
    </template>
  </PEmpty>
</template>
