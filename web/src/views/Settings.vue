<script setup lang="ts">
import { hideNSFW } from '@/shared'
</script>

<template>
  <div class="mx-auto px-6 py-8 max-w-3xl">
    <div class="mb-6 pb-4 border-b border-border-default flex gap-3 items-center">
      <i class="i-tabler-settings text-xl text-fg-muted" />
      <h2 class="text-2xl text-fg tracking-tight font-semibold">
        Settings
      </h2>
    </div>

    <div class="space-y-3">
      <section class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong">
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-palette text-lg text-fg-muted mt-0.5" />
            <div>
              <h3 class="text-fg font-medium">
                Color Scheme
              </h3>
              <p class="text-sm text-fg-muted mt-0.5">
                Change color scheme of the application.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSchemeSwitch />
          </div>
        </div>
      </section>

      <section class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong">
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-eyeglass-filled text-lg text-fg-muted mt-0.5" />
            <div>
              <h3 class="text-fg font-medium">
                Hide NSFW
              </h3>
              <p class="text-sm text-fg-muted mt-0.5">
                Blur Not Safe For Work content.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSwitch
              v-model="hideNSFW"
              on-icon="i-tabler-eyeglass-filled"
            />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
