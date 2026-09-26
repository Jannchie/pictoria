<script setup lang="ts">
// Catch-all route target. Without it an unknown address rendered an empty
// middle pane with nothing to say why or where to go.
</script>

<template>
  <div class="flex h-full items-center justify-center">
    <PEmpty icon="i-tabler-map-question">
      <span class="text-base text-fg font-medium block">{{ $t('common.notFoundTitle') }}</span>
      <span class="mt-1 block">{{ $t('common.notFoundBody') }}</span>
      <template #action>
        <PButton
          size="sm"
          variant="secondary"
          class="mt-2"
          @click="$router.push('/')"
        >
          <i class="i-tabler-photo" aria-hidden="true" />
          {{ $t('common.backToGallery') }}
        </PButton>
      </template>
    </PEmpty>
  </div>
</template>
