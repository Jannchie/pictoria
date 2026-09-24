<script lang="ts" setup>
import type { Toast, ToastData } from '@/shared/toast'
import { dismissToast, pauseToasts, resumeToasts, toasts } from '@/shared/toast'

// Renders the global toast queue (shared/toast.ts) — mounted once in App.vue.
// pushToast() owns the auto-dismiss timer; this component only displays,
// forwards manual dismissals, and holds the timers while a toast is hovered
// or focused (PToastContainer decides when).
const TYPE_STYLE: Record<ToastData['type'], { icon: string, color: string }> = {
  info: { icon: 'i-tabler-info-circle', color: 'var(--p-primary)' },
  success: { icon: 'i-tabler-circle-check', color: 'var(--p-success)' },
  warning: { icon: 'i-tabler-alert-triangle', color: 'var(--p-warning)' },
  error: { icon: 'i-tabler-alert-circle', color: 'var(--p-danger)' },
}

const toastKey = (item: Toast) => item.id
</script>

<template>
  <PToastContainer
    :items="toasts"
    :item-key="toastKey"
    @pause="pauseToasts"
    @resume="resumeToasts"
  >
    <template #default="{ item }">
      <PToast
        :message="item.message"
        :tone="item.type"
        :icon="TYPE_STYLE[item.type].icon"
        :icon-color="item.color ?? TYPE_STYLE[item.type].color"
        :closeable="item.closeable"
        @close="dismissToast(item)"
      />
    </template>
  </PToastContainer>
</template>
