<script lang="ts" setup>
import { ref } from 'vue'

const toasts = ref([{
  message: 'Hello',
}, {
  message: 'Hello',
}])
</script>

<template>
  <ToastContainer :items="toasts">
    <template #default="{ item }">
      <Toast v-bind="item" />
    </template>
  </ToastContainer>
</template>
