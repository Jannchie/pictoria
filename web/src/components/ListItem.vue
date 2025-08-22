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
    class="px-2 py-1 rounded flex gap-2 w-full items-center"
    :class="{
      'bg-surface-variant-1': active && type === 'normal',
      'bg-surface-variant-2': hover || dragover,
    }"
    @dragover="onDragOver"
    @dragleave="onDragleave"
    @drop="onDrop"
  >
    <Checkbox
      v-if="type === 'checkbox'"
      class="flex-shrink-0 pointer-events-none"
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
      class="text-xs text-surface-dimmed font-mono flex-shrink-0"
    >
      {{ extraInfo }}
    </div>
  </div>
</template>
