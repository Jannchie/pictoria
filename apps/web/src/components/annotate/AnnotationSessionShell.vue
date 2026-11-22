<script setup lang="ts">
import type { AnnotationKind, StreamLoadState } from '@/composables/useAnnotationStream'
import { computed, useTemplateRef } from 'vue'
import AnnotationFinished from '@/components/annotate/AnnotationFinished.vue'
import AnnotationKeyHints from '@/components/annotate/AnnotationKeyHints.vue'
import AnnotationLoadError from '@/components/annotate/AnnotationLoadError.vue'
import AnnotationSpinner from '@/components/annotate/AnnotationSpinner.vue'

// The markup the three annotation sessions share: the focusable session region,
// the top bar (exit, title, progress, key legend) and the state block that stands
// in for the judging surface when there is nothing on it (finished / load error /
// loading). The logic is shared through useAnnotationStream and
// useAnnotationSessionFrame; this is only the frame around it, so the three
// sessions cannot drift apart visually.
//
// Slots, in DOM order:
// - `after-title`  — inline next to the title (absolute: the content-flag status)
// - `after-progress` — next to the progress count (listwise: model agreement)
// - `header`       — the strip above the body (question, review banner)
// - default        — the judging surface, rendered while `active`
// - `finished`     — extra actions on the finished screen. Only forwarded when the
//                    session provides it: AnnotationFinished styles its Home button
//                    by whether it got any slot at all.
// - `loading`      — replaces the default spinner + "Loading…" line
// - `outside`      — after the body, inside the region (listwise: its lightbox)
const props = defineProps<{
  title: string
  /** The top bar's progress text. */
  progress: string
  hints: { keys: string[], label: string }[]
  kind: AnnotationKind
  done: number
  loadState: StreamLoadState
  /** Something is on the judging surface: show the default slot, not the state block. */
  active: boolean
  /** The legend is long (listwise): let the right side of the top bar wrap and
   *  shrink instead of squeezing the title and the exit button off screen. */
  wrapHints?: boolean
}>()
const emit = defineEmits<{ exit: [], retry: [] }>()

const exhausted = computed(() => props.loadState === 'exhausted')
// Ran dry with nothing on screen: the key legend has nothing to act on.
const finished = computed(() => exhausted.value && !props.active)

const root = useTemplateRef<HTMLElement>('root')
defineExpose({ root })
</script>

<template>
  <div ref="root" class="annotation-session flex flex-col h-full" tabindex="-1" role="region" :aria-label="title">
    <!-- 顶栏 -->
    <div
      class="text-sm px-4 py-2.5 p-divider flex shrink-0 items-center justify-between"
      :class="{ 'gap-4': wrapHints }"
    >
      <div
        class="flex gap-3 min-w-0 items-center"
        :class="{ 'shrink-0 max-w-1/3': wrapHints }"
      >
        <button
          type="button"
          class="annotation-session__exit"
          :aria-label="$t('annotate.session.exit')"
          :title="$t('annotate.session.exitHint', { key: 'Esc' })"
          aria-keyshortcuts="Escape"
          @click="emit('exit')"
        >
          <i class="i-tabler-arrow-left" aria-hidden="true" />
        </button>
        <h2 class="text-fg font-medium truncate">
          {{ title }}
        </h2>
        <slot name="after-title" />
      </div>
      <!-- 键位说明较长时（wrapHints）：窄窗口下让它换行，而不是把标题和返回按钮挤出屏幕。 -->
      <div
        class="text-xs text-fg-muted flex gap-4 items-center"
        :class="wrapHints ? 'min-w-0 justify-end' : 'shrink-0'"
      >
        <span
          class="text-fg font-medium tabular-nums"
          :class="{ 'shrink-0 whitespace-nowrap': wrapHints }"
        >{{ progress }}</span>
        <slot name="after-progress" />
        <AnnotationKeyHints v-if="!finished" :hints="hints" />
      </div>
    </div>

    <div class="flex flex-1 flex-col min-h-0 min-w-0">
      <slot name="header" />
      <slot v-if="active" />

      <!-- 空态 / 完成态 -->
      <div v-else class="flex flex-1 items-center justify-center">
        <AnnotationFinished v-if="exhausted" :kind="kind" :done="done" @home="emit('exit')">
          <template v-if="$slots.finished" #default>
            <slot name="finished" />
          </template>
        </AnnotationFinished>
        <AnnotationLoadError v-else-if="loadState === 'error'" @retry="emit('retry')" />
        <slot v-else name="loading">
          <div role="status" class="text-sm text-fg-muted flex gap-2 items-center">
            <AnnotationSpinner />{{ $t('common.loading') }}
          </div>
        </slot>
      </div>
    </div>

    <slot name="outside" />
  </div>
</template>

<style scoped>
.annotation-session:focus {
  outline: none;
}

.annotation-session__exit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--p-radius-sm);
  background: transparent;
  color: var(--p-fg-muted);
  cursor: pointer;
  transition: background-color var(--p-transition-fast), color var(--p-transition-fast);
}
.annotation-session__exit:hover {
  background: rgb(var(--p-primary-rgb) / 0.12);
  color: var(--p-fg);
}
</style>
