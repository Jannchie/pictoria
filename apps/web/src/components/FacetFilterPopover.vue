<script setup lang="ts" generic="I, V extends string | number">
import { computed, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { facetOptionLabel, facetTriggerLabel, initialOptionIndex, useFacetListbox } from '@/composables/useFacetFilter'

/**
 * The shell every popover facet filter (rating / score / extension / scorer
 * bucket) shares: a trigger button that shows the selection, opening a
 * multi-select listbox of options with counts. The filter owns its state
 * (`useFacetFilter`) and passes in only what is its own — the options, how a
 * value is named, the trigger icon and each row's content.
 *
 * Items are the popover rows; `itemValue` maps one to the value it filters by
 * (the item itself for a plain list of values). That value is also the row's key.
 */
const props = defineProps<{
  /** Facet name: the trigger text at rest, and the accessible name of the trigger and the listbox. */
  label: string
  /** Popover rows, in display order. */
  items: readonly I[]
  /** The filter value of a row; defaults to the item itself. */
  itemValue?: (item: I) => V
  /** Selected values, in the order the trigger lists them. */
  selection: readonly V[]
  /** Spoken name of a value: the trigger's accessible name, and the default option name / typeahead text. */
  valueName: (value: V) => string
  /** Visible text of a selected value on the trigger; defaults to `valueName`. */
  valueText?: (value: V) => string
  /** Visible prefix before the selected values on the trigger ("SILVA: A, B"). */
  chipPrefix?: string
  /** Name of an option in its accessible name; defaults to `valueName`. */
  optionName?: (item: I) => string
  /** Typeahead text of an option; defaults to `valueName`. */
  typeahead?: (item: I) => string
  /** Count column per value (`useFacetFilter().count`). */
  count: (value: V) => number | undefined
  /** Count in the option's accessible name (`useFacetFilter().optionCount`). */
  optionCount: (value: V) => number | undefined
  share: (count: number) => string
  /** Trigger icon, unless the `icon` slot replaces it. */
  icon?: string
  /** Class of the trigger's text span. */
  textClass?: string
  /** Width classes of the popover panel. */
  panelClass?: string
}>()

const emit = defineEmits<{
  toggle: [value: V]
}>()

defineSlots<{
  /** Trigger icon(s); defaults to `icon`. */
  icon?: () => unknown
  /** A row's content, after its checkbox. */
  default: (props: { item: I }) => unknown
}>()

/** Popover open state — bind the filter's `opened` (it gates the count query). */
const opened = defineModel<boolean>('opened', { required: true })

const { t } = useI18n()

const itemValueOf = (item: I): V => props.itemValue ? props.itemValue(item) : item as unknown as V
const itemSelected = (item: I) => props.selection.includes(itemValueOf(item))
const itemCount = (item: I) => props.count(itemValueOf(item))
const itemTypeahead = (item: I) => props.typeahead ? props.typeahead(item) : props.valueName(itemValueOf(item))
function optionLabel(item: I) {
  const name = props.optionName ? props.optionName(item) : props.valueName(itemValueOf(item))
  return facetOptionLabel(t, name, props.optionCount(itemValueOf(item)))
}
function onToggle(item: I) {
  emit('toggle', itemValueOf(item))
}

const btnText = computed(() => {
  const values = props.selection
  if (values.length === 0) {
    return props.label
  }
  const show = props.valueText ?? props.valueName
  const text = values.map(v => show(v)).join(', ')
  return props.chipPrefix === undefined ? text : `${props.chipPrefix}: ${text}`
})

const listbox = useTemplateRef<{ el: HTMLElement | null }>('listbox')
useFacetListbox(() => listbox.value?.el)
const autofocusIndex = computed(() => initialOptionIndex(props.items, itemSelected))
const triggerLabel = computed(() => facetTriggerLabel(t, props.label, props.selection.map(v => props.valueName(v))))
</script>

<template>
  <div class="relative">
    <PPopover v-model="opened" position="bottom-start">
      <PButton
        size="sm"
        :variant="selection.length > 0 ? 'subtle' : 'secondary'"
        :active="opened"
        :aria-label="triggerLabel"
      >
        <slot name="icon">
          <i :class="icon" aria-hidden="true" />
        </slot>
        <span :class="textClass">
          {{ btnText }}
        </span>
      </PButton>
      <template #content>
        <PFacetList
          ref="listbox"
          :aria-label="label"
          class="p-popover-panel"
          :class="panelClass"
          :items="items"
          :item-key="itemValueOf"
          :selected="itemSelected"
          :option-label="optionLabel"
          :typeahead="itemTypeahead"
          :autofocus-index="autofocusIndex"
          :count="itemCount"
          :share="share"
          @toggle="onToggle"
        >
          <template #default="{ item }">
            <slot :item="item" />
          </template>
        </PFacetList>
      </template>
    </PPopover>
  </div>
</template>
