<script setup lang="ts">
import { useStorage } from '@vueuse/core'
import { computed, useId } from 'vue'

/**
 * A collapsible section with the panel section-heading look (small uppercase
 * label + leading icon). Open state persists per `storageKey` so a panel the
 * user collapsed stays collapsed across posts and reloads — the point is to let
 * someone keep the high-frequency controls above the fold permanently.
 */
const props = withDefaults(
  defineProps<{
    /** localStorage suffix; omit for an uncontrolled (non-persisted) section. */
    storageKey?: string
    title: string
    icon?: string
    defaultOpen?: boolean
    /** Optional right-aligned summary shown while collapsed (e.g. a count). */
    summary?: string | number
  }>(),
  { defaultOpen: true },
)

const contentId = useId()

// useStorage with a undefined key would collide across instances, so fall back
// to a plain ref-like computed backed by a local storage-less ref.
const persisted = props.storageKey
  ? useStorage(`pictoria.disclosure.${props.storageKey}`, props.defaultOpen)
  : ref(props.defaultOpen)

const isOpen = computed({
  get: () => persisted.value,
  set: (v: boolean) => {
    persisted.value = v
  },
})
</script>

<template>
  <section class="py-3 p-divider">
    <button
      type="button"
      class="group/disclosure py-0.5 rounded flex w-full transition-colors items-center"
      :aria-expanded="isOpen"
      :aria-controls="contentId"
      @click="isOpen = !isOpen"
    >
      <i
        class="i-tabler-chevron-down text-fg-subtle mr-1 shrink-0 h-3.5 w-3.5 transition-transform"
        :class="{ '-rotate-90': !isOpen }"
        aria-hidden="true"
      />
      <i
        v-if="icon"
        :class="icon"
        class="text-fg-subtle mr-1.5 shrink-0"
        aria-hidden="true"
      />
      <span class="text-[11px] text-fg-subtle tracking-wider font-semibold uppercase group-hover/disclosure:text-fg-muted">
        {{ title }}
      </span>
      <span
        v-if="summary !== undefined && !isOpen"
        class="text-fg-subtle font-mono ml-auto tabular-nums"
      >{{ summary }}</span>
    </button>
    <div
      v-show="isOpen"
      :id="contentId"
      class="mt-2"
    >
      <slot />
    </div>
  </section>
</template>
