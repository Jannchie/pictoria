<script setup lang="ts">
import { useTimeoutFn } from '@vueuse/core'
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { dismissUndoSnackbar, performRedo, performUndo, undoSnackbar } from '@/shared/undoSnackbar'

const { t } = useI18n()

const AUTO_DISMISS_MS = 5000

const { start, stop } = useTimeoutFn(dismissUndoSnackbar, AUTO_DISMISS_MS, { immediate: false })

// Restart the dismiss countdown whenever a new snackbar is shown (id changes).
watch(() => undoSnackbar.value?.id, (id) => {
  if (id !== undefined) {
    start()
  }
}, { immediate: true })

const data = computed(() => undoSnackbar.value)
const actionLabel = computed(() => (data.value?.action === 'redo' ? t('common.redo') : t('common.undo')))
const actionIcon = computed(() => (data.value?.action === 'redo' ? 'i-tabler-arrow-forward-up' : 'i-tabler-arrow-back-up'))

function onAction() {
  if (data.value?.action === 'undo') {
    performUndo()
  }
  else if (data.value?.action === 'redo') {
    performRedo()
  }
}
</script>

<template>
  <div class="px-4 pb-6 flex pointer-events-none bottom-0 left-0 right-0 justify-center fixed z-[var(--p-z-toast)]">
    <Transition name="undo-snackbar">
      <!-- 同一张卡片，只是换了个角落：顶部通知队列用的也是 PToast。这里单条、
           宽度随内容(fluid)，并把撤销/重做塞进 action 插槽。 -->
      <PToast
        v-if="data"
        fluid
        class="pointer-events-none"
        :message="data.message"
        :icon="data.tone === 'error' ? 'i-tabler-alert-triangle' : undefined"
        icon-color="var(--p-fg-muted)"
      >
        <template #action>
          <button
            v-if="data.action"
            type="button"
            class="text-primary font-medium px-2 py-0.5 rounded flex flex-shrink-0 gap-1 pointer-events-auto transition-colors items-center focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 focus-visible:outline hover:bg-surface-2"
            @click="onAction"
            @mouseenter="stop"
            @mouseleave="start"
          >
            <i :class="actionIcon" aria-hidden="true" />
            {{ actionLabel }}
          </button>
        </template>
      </PToast>
    </Transition>
  </div>
</template>

<style scoped>
.undo-snackbar-enter-active,
.undo-snackbar-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.undo-snackbar-enter-from,
.undo-snackbar-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}
</style>
