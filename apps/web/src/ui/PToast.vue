<script setup lang="ts">
defineProps<{
  message: string
  icon?: string
  iconColor?: string
  closeable?: boolean
  /**
   * 默认固定宽度：顶部队列里多条并存时左右边缘要对齐。
   * fluid 时宽度随内容收缩，给单条、贴边出现的用法(撤销 snackbar)。
   */
  fluid?: boolean
}>()
const emit = defineEmits<{
  close: []
}>()
</script>

<template>
  <div
    role="status"
    class="text-sm text-fg px-4 py-2 border border-border-default rounded-xl bg-surface inline-flex gap-2 shadow-md items-center"
    :class="fluid ? 'max-w-full' : 'w-96'"
  >
    <div
      v-if="icon"
      class="flex-shrink-0"
      aria-hidden="true"
      :style="iconColor ? { color: iconColor } : undefined"
    >
      <i :class="icon" />
    </div>
    <div class="flex-grow" :class="fluid ? 'truncate' : ''">
      {{ message }}
    </div>
    <!-- 行动入口(撤销/重做…)排在关闭键左边，和消息之间靠容器的 gap 分隔。 -->
    <slot name="action" />
    <button
      v-if="closeable"
      type="button"
      aria-label="Dismiss notification"
      class="text-fg-muted rounded flex flex-shrink-0 h-5 w-5 transition-colors items-center justify-center hover:text-fg focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 focus-visible:outline hover:bg-surface-2"
      @click="emit('close')"
    >
      <i class="i-tabler-x" aria-hidden="true" />
    </button>
  </div>
</template>
