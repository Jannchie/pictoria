<script lang="ts" setup>
import type { ToastData } from '@/shared/toast'
import { dismissToast, toasts } from '@/shared/toast'

// Renders the global toast queue (shared/toast.ts) — mounted once in App.vue.
// pushToast() owns the auto-dismiss timer; this component only displays and
// forwards manual dismissals.
const TYPE_STYLE: Record<ToastData['type'], { icon: string, color: string }> = {
  info: { icon: 'i-tabler-info-circle', color: 'var(--p-primary)' },
  success: { icon: 'i-tabler-circle-check', color: 'var(--p-success)' },
  warning: { icon: 'i-tabler-alert-triangle', color: 'var(--p-warning)' },
  error: { icon: 'i-tabler-alert-circle', color: 'var(--p-danger)' },
}
</script>

<template>
  <PToastContainer :items="toasts">
    <template #default="{ item }">
      <PToast
        :message="item.message"
        :icon="TYPE_STYLE[item.type].icon"
        :icon-color="item.color ?? TYPE_STYLE[item.type].color"
        :closeable="item.closeable"
        @close="dismissToast(item)"
      />
    </template>
  </PToastContainer>
</template>
