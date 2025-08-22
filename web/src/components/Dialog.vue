<script setup lang="ts">
import { Btn, Paper } from '@roku-ui/vue'
</script>

<template>
  <Paper
    class="shadow-surface-lowest/25 border-primary-container text-sm flex flex-col gap-2 min-w-86 shadow"
    with-border
  >
    <div>
      Dialog123
    </div>
    <div class="flex justify-end">
      <Btn
        color="primary"
        variant="filled"
      >
        Primary
      </Btn>
    </div>
  </Paper>
</template>
