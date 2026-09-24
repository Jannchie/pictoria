<script setup lang="ts">
// Purely visual scrim. It carries no semantics: the dialog placed in its slot
// is the modal layer (PDialog registers `useLayer({ modal: true })`), and the
// scrim is just that layer's backdrop.
//
// Teleported to <body> so a modal inside it is a direct child subtree of
// <body>: the layer stack can then set `inert` on every other body child
// (`#app` included) — it refuses to inert anything while the modal lives
// inside `#app`. The scrim is `position: fixed; inset: 0`, so moving it out of
// the app tree changes nothing visually.
//
// Click-to-dismiss stays at the call site (`@click.self`), and Escape belongs
// to the dialog's layer — the scrim itself registers nothing.
defineOptions({ inheritAttrs: false })

withDefaults(defineProps<{
  opacity?: number
  /** Render in place instead of teleporting to <body> (loses inert). */
  inline?: boolean
}>(), {
  opacity: 0.4,
  inline: false,
})
</script>

<template>
  <Teleport to="body" :disabled="inline">
    <Transition appear name="p-float-fade">
      <div
        class="p-overlay"
        data-overlay
        :style="{ background: `rgb(0 0 0 / ${opacity})` }"
        v-bind="$attrs"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.p-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--p-z-overlay);
}
</style>
