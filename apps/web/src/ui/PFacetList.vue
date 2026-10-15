<script setup lang="ts" generic="T">
import { useTemplateRef } from 'vue'
import { activateOptionOnKey } from './listboxKeys'
import PCheckbox from './PCheckbox.vue'

/**
 * Multi-select facet listbox: the body of a filter popover. Renders
 * `role=listbox` (`aria-multiselectable`) with one `role=option` row per item —
 * a decorative checkbox, the caller's content (default slot), and an optional
 * count + share column.
 *
 * Keyboard: Space / Enter on a focused option emit `toggle` (IME, chords and
 * auto-repeat ignored), as does a pointer / AT click. Focus movement is NOT
 * owned here: the caller attaches roving focus to the exposed `el` (rows carry
 * `data-typeahead` / `data-autofocus` for it), so a list can opt into
 * typeahead, looping, or hand focus to a sibling search box. Every other key
 * reaches the caller through `option-keydown`, after the toggle handling (a
 * consumed key arrives with `defaultPrevented`).
 *
 * Attributes (`aria-label`, `id`, `class`, `aria-busy`) fall through to the
 * listbox element.
 */
const props = defineProps<{
  items: readonly T[]
  /** `:key` per row; defaults to the item itself (primitive items). */
  itemKey?: (item: T) => string | number
  selected: (item: T) => boolean
  /** Accessible name of an option (usually label + count). */
  optionLabel: (item: T) => string
  /** Typeahead text per option; omit to leave rows without `data-typeahead`. */
  typeahead?: (item: T) => string
  /** Row marked `data-autofocus` (where roving focus lands on open). */
  autofocusIndex?: number
  /**
   * Count per option. With it, a right-hand column shows the count (and the
   * share, when `share` is given and the count is non-zero) for rows that
   * have a count or are selected.
   */
  count?: (item: T) => number | undefined
  /** Formats a count as a percentage string (without the `%`). */
  share?: (count: number) => string
}>()

const emit = defineEmits<{
  toggle: [item: T]
  optionKeydown: [event: KeyboardEvent, item: T, index: number]
}>()

defineSlots<{
  default: (props: { item: T, index: number, selected: boolean }) => unknown
}>()

const el = useTemplateRef<HTMLElement>('el')
defineExpose({ el })

function onKeydown(e: KeyboardEvent, item: T, index: number) {
  activateOptionOnKey(e, () => emit('toggle', item))
  emit('optionKeydown', e, item, index)
}
</script>

<template>
  <div
    ref="el"
    role="listbox"
    aria-multiselectable="true"
  >
    <div
      v-for="(item, i) in props.items"
      :key="itemKey ? itemKey(item) : (item as string | number)"
      role="option"
      :aria-selected="selected(item)"
      :aria-label="optionLabel(item)"
      :data-typeahead="typeahead?.(item)"
      :data-autofocus="i === autofocusIndex || undefined"
      class="text-xs px-2 py-1 rounded flex gap-2 w-full cursor-pointer items-center hover:bg-surface-2 focus-visible:[outline-offset:-2px]"
      @click="emit('toggle', item)"
      @keydown="onKeydown($event, item, i)"
    >
      <PCheckbox
        class="flex-shrink-0 pointer-events-none"
        :model-value="selected(item)"
        inert
        aria-hidden="true"
      />
      <slot :item="item" :index="i" :selected="selected(item)" />
      <div
        v-if="count && (count(item) || selected(item))"
        class="font-mono inline-flex flex-shrink-0 tabular-nums"
      >
        <span class="text-right flex-shrink-0 w-10" :class="count(item) ? 'text-fg-muted' : 'text-fg-subtle'">{{ count(item) || 0 }}</span>
        <span v-if="share && count(item)" class="text-fg-subtle text-right flex-shrink-0 w-14">{{ share(count(item)!) }}%</span>
      </div>
    </div>
  </div>
</template>
