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
const isActive = computed(() => props.active && props.type === 'normal')
defineExpose({
  title: props.title,
})
</script>

<template>
  <!-- Same selected / hover vocabulary as the sidebar folder tree (PTreeList):
       a primary wash for the current item, a surface step for hover, and the
       icon carrying the accent colour instead of the whole label. -->
  <div
    ref="folderItemRef"
    class="px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
    :class="{
      'text-fg-muted': !isActive && !(hover || dragover),
      'text-fg bg-surface-1': !isActive && (hover || dragover),
      'text-fg bg-primary/10 font-medium': isActive && !(hover || dragover),
      'text-fg bg-primary/15 font-medium': isActive && (hover || dragover),
    }"
    @dragover="onDragOver"
    @dragleave="onDragleave"
    @drop="onDrop"
  >
    <PCheckbox
      v-if="type === 'checkbox'"
      class="flex-shrink-0 pointer-events-none"
      :model-value="active"
    />
    <i
      v-if="icon"
      class="flex-shrink-0 h-4 w-4"
      :class="[icon, isActive ? 'text-primary' : 'text-fg-subtle']"
    />
    <div class="flex-grow truncate">
      {{ title }}
    </div>
    <div
      v-if="extraInfo"
      class="text-xs text-fg-subtle font-mono flex-shrink-0 tabular-nums"
    >
      {{ extraInfo }}
    </div>
  </div>
</template>
