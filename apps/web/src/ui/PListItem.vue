<script setup lang="ts">
import type { RouteLocationRaw } from 'vue-router'
import { useElementHover } from '@vueuse/core'
import { computed, inject, ref } from 'vue'
import { routeLocationKey, routerKey, RouterLink } from 'vue-router'

/**
 * One row of a list / menu / nav. Three ways to render it:
 *
 * - `to` → a RouterLink (`<a href>`): Enter, middle-click, "open in new tab"
 *   all work, and it gets `aria-current="page"` while its route is active.
 * - `as="button"` / `as="a"` → that native element (keyboard for free).
 * - default `<div>`: give it a `role` (`menuitem`, `option`,
 *   `menuitemcheckbox`…) and it becomes focusable (`tabindex=0`) with
 *   Enter / Space dispatching a real `click`, so a caller's existing `@click`
 *   runs for keyboard users too. Inside a roving-tabindex parent pass
 *   `:focusable="false"` — the parent owns tabindex then.
 *
 * Every activation (pointer, keyboard, assistive tech) ends up as one
 * `click`, and emits `activate` once.
 */
const props = withDefaults(defineProps<{
  title: string
  icon?: string
  extraInfo?: any
  /** Selected look (and `aria-checked` for `type="checkbox"` rows with a role). Defaults to "route is active" when `to` is set. */
  active?: boolean
  type?: 'normal' | 'checkbox'
  /** ARIA role for the row (menuitem, option, menuitemcheckbox, …). */
  role?: string
  /**
   * Tab stop control. Default: focusable when it has a `role` (or is a
   * button / link). `false` = a roving-tabindex parent manages `tabindex`;
   * the row never binds one itself.
   */
  focusable?: boolean
  /** `aria-current`; `true` → "true". RouterLink rows set "page" themselves. */
  current?: boolean | 'page' | 'step' | 'location' | 'date' | 'time'
  as?: 'div' | 'button' | 'a'
  to?: RouteLocationRaw
}>(), {
  active: undefined,
  type: 'normal',
  focusable: undefined,
  current: undefined,
  as: 'div',
})
const emit = defineEmits<{
  dragover: [DragEvent]
  dragleave: [DragEvent]
  drop: [DragEvent]
  activate: [MouseEvent]
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

// Injected softly so the component also mounts without a router (tests,
// rows that never use `to`).
const router = inject(routerKey, null)
const route = inject(routeLocationKey, null)
const routeActive = computed(() => {
  if (props.to === undefined || !router || !route) {
    return false
  }
  try {
    return router.resolve(props.to).path === route.path
  }
  catch {
    return false
  }
})

const isActive = computed(() => (props.active ?? routeActive.value) && props.type === 'normal')
const checked = computed(() => !!(props.active ?? routeActive.value))

const tag = computed(() => props.to === undefined ? props.as : RouterLink)
const isNative = computed(() => props.to !== undefined || props.as !== 'div')

const rowAttrs = computed(() => {
  const attrs: Record<string, unknown> = {}
  if (props.to !== undefined) {
    attrs.to = props.to
  }
  if (props.as === 'button' && props.to === undefined) {
    attrs.type = 'button'
  }
  if (props.role) {
    attrs.role = props.role
  }
  if (props.focusable !== false) {
    if (props.focusable === true && !isNative.value) {
      attrs.tabindex = 0
    }
    else if (props.role && !isNative.value) {
      attrs.tabindex = 0
    }
  }
  if (props.type === 'checkbox' && props.role) {
    attrs['aria-checked'] = String(checked.value)
  }
  // Only set when asked: an explicit `undefined` would override the
  // aria-current RouterLink computes for itself.
  if (props.current !== undefined && props.current !== false) {
    attrs['aria-current'] = props.current === true ? 'true' : props.current
  }
  return attrs
})

function onKeydown(e: KeyboardEvent) {
  // Native button / link rows get Enter (and Space for buttons) from the
  // browser; a nested control's keys are its own.
  if (isNative.value || e.target !== e.currentTarget) {
    return
  }
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) {
    return
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    if (!e.repeat) {
      (e.currentTarget as HTMLElement).click()
    }
  }
}

defineExpose({
  title: computed(() => props.title),
})
</script>

<template>
  <!-- Same selected / hover vocabulary as the sidebar folder tree (PTreeList):
       a primary wash for the current item, a surface step for hover, and the
       icon carrying the accent colour instead of the whole label.
       bg-transparent only for <button> rows (the compat reset keeps the UA
       button background); div rows get none so callers' bg classes win. -->
  <component
    :is="tag"
    ref="folderItemRef"
    v-bind="rowAttrs"
    class="p-list-item px-2.5 rounded flex gap-2 min-h-7 w-full cursor-pointer transition-colors items-center"
    :class="{
      'text-fg-muted': !isActive && !(hover || dragover),
      'bg-transparent': tag === 'button' && !isActive && !(hover || dragover),
      'text-fg bg-surface-1': !isActive && (hover || dragover),
      'text-fg bg-primary/10 font-medium': isActive && !(hover || dragover),
      'text-fg bg-primary/15 font-medium': isActive && (hover || dragover),
    }"
    @click="(e: MouseEvent) => emit('activate', e)"
    @keydown="onKeydown"
    @dragover="onDragOver"
    @dragleave="onDragleave"
    @drop="onDrop"
  >
    <PCheckbox
      v-if="type === 'checkbox'"
      class="flex-shrink-0 pointer-events-none"
      :model-value="checked"
      :presentational="!!role"
    />
    <i
      v-if="icon"
      class="flex-shrink-0 h-4 w-4"
      :class="[icon, isActive ? 'text-primary' : 'text-fg-subtle']"
      aria-hidden="true"
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
  </component>
</template>

<style scoped>
/* Native button / link rows: drop UA chrome so they look like the div row.
   Colours and backgrounds come from the utility classes above — nothing
   here may out-rank them. */
button.p-list-item {
  border: 0;
  font: inherit;
  text-align: start;
}
a.p-list-item {
  text-decoration: none;
}
</style>
