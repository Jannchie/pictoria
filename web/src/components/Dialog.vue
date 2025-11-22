<script setup lang="ts">
import { Btn, Paper } from '@roku-ui/vue'
</script>

<template>
  <Paper
    class="bg-base border-container text-sm border flex flex-col gap-2 min-w-86 shadow"
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
