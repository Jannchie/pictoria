<script setup lang="ts">
import { ref } from 'vue'

const items = ref(Array.from({ length: 200 }, _ => Math.random() * 60 + 30))
</script>

<template>
  <div
    class="h-full"
  >
    <VirtualScroll
      :items="items"
    >
      <template #default="{ item, index }">
        <div
          :style="{
            height: `${item}px`,
          }"
        >
          {{ index }}
        </div>
      </template>
    </VirtualScroll>
  </div>
</template>
