<script setup lang="ts">
import { hideNSFW } from '@/shared'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-8">
    <div class="mb-6 flex items-center gap-3 border-b border-border-default pb-4">
      <i class="i-tabler-settings text-xl text-fg-muted" />
      <h2 class="text-2xl text-fg font-semibold tracking-tight">
        Settings
      </h2>
    </div>

    <div class="space-y-3">
      <section class="border border-border-default rounded-lg bg-surface-1 px-5 py-4 transition-colors hover:border-border-strong">
        <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
          <div class="flex items-start gap-3">
            <i class="i-tabler-palette mt-0.5 text-lg text-fg-muted" />
            <div>
              <h3 class="text-fg font-medium">
                Color Scheme
              </h3>
              <p class="mt-0.5 text-sm text-fg-muted">
                Change color scheme of the application.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSchemeSwitch />
          </div>
        </div>
      </section>

      <section class="border border-border-default rounded-lg bg-surface-1 px-5 py-4 transition-colors hover:border-border-strong">
        <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
          <div class="flex items-start gap-3">
            <i class="i-tabler-eyeglass-filled mt-0.5 text-lg text-fg-muted" />
            <div>
              <h3 class="text-fg font-medium">
                Hide NSFW
              </h3>
              <p class="mt-0.5 text-sm text-fg-muted">
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
