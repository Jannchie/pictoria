<script setup lang="ts">
const props = withDefaults(defineProps<{
  title: string
  icon?: string
  extraInfo?: any
  active?: boolean
  type?: 'normal' | 'checkbox'
}>(), {
  active: false,
  type: 'normal',
})
const emit = defineEmits<{
  dragover: [DragEvent]
  dragleave: [DragEvent]
  drop: [DragEvent]
}>()
const dragover = ref(false)
function onDragOver(event: DragEvent) {
  dragover.value = true
  emit('dragover', event)
}
function onDragleave(event: DragEvent) {
  dragover.value = false
  emit('dragleave', event)
}
function onDrop(event: DragEvent) {
  dragover.value = false
  emit('drop', event)
}
const folderItemRef = ref<HTMLElement | null>(null)
const hover = useElementHover(folderItemRef)
defineExpose({
  title: props.title,
})
</script>

<template>
  <div
    ref="folderItemRef"
    class="min-h-7 w-full flex items-center gap-2 rounded px-2.5 transition-colors"
    :class="{
      'bg-surface-2 text-primary font-medium': active && type === 'normal' && !(hover || dragover),
      'bg-surface-2': (hover || dragover) && !(active && type === 'normal'),
      'bg-surface-3 text-primary font-medium': (hover || dragover) && active && type === 'normal',
    }"
    @dragover="onDragOver"
    @dragleave="onDragleave"
    @drop="onDrop"
  >
    <Checkbox
      v-if="type === 'checkbox'"
      class="pointer-events-none flex-shrink-0"
      :model-value="active"
    />
    <i
      v-if="icon"
      class="flex-shrink-0"
      :class="icon"
    />
    <div class="flex-grow truncate">
      {{ title }}
    </div>
    <div
      v-if="extraInfo"
      class="flex-shrink-0 text-xs text-fg-muted font-mono"
    >
      {{ extraInfo }}
    </div>
  </div>
</template>
