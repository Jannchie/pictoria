<script setup lang="ts">
function onBeforeEnter(element: Element) {
  if (element instanceof HTMLElement) {
    element.style.height = `${0}px`
  }
}
function onEnter(element: Element) {
  if (element instanceof HTMLElement) {
    element.style.height = `${element.scrollHeight}px`
  }
}
function onAfterEnter(element: Element) {
  if (element instanceof HTMLElement) {
    element.style.height = 'auto'
  }
}
function onBeforeLeave(element: Element) {
  if (element instanceof HTMLElement) {
    element.style.height = `${element.scrollHeight}px`
  }
}
function onLeave(element: Element) {
  if (element instanceof HTMLElement) {
    element.style.height = `${0}px`
  }
}
</script>

<template>
  <Transition
    css
    mode="out-in"
    class="transition-height"
    @before-enter="onBeforeEnter"
    @enter="onEnter"
    @after-enter="onAfterEnter"
    @before-leave="onBeforeLeave"
    @leave="onLeave"
  >
    <slot />
  </Transition>
</template>
