<script setup lang="ts">
import { enableArthash, enableFancyPlaceholder, hideNSFW } from '@/shared'
</script>

<template>
  <main class="mx-auto px-6 py-8 max-w-3xl">
    <div class="mb-6 pb-4 border-b border-border-default flex gap-3 items-center">
      <i class="i-tabler-settings text-xl text-fg-muted" aria-hidden="true" />
      <h1 class="text-2xl text-fg tracking-tight font-semibold text-pretty">
        Settings
      </h1>
    </div>

    <div class="space-y-3">
      <section
        aria-labelledby="setting-color-scheme"
        class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong"
      >
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-palette text-lg text-fg-muted mt-0.5" aria-hidden="true" />
            <div>
              <h2 id="setting-color-scheme" class="text-fg font-medium">
                Color Scheme
              </h2>
              <p class="text-sm text-fg-muted mt-0.5">
                Switch the app between light and dark.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSchemeSwitch />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="setting-hide-nsfw"
        class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong"
      >
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-eyeglass-filled text-lg text-fg-muted mt-0.5" aria-hidden="true" />
            <div>
              <h2 id="setting-hide-nsfw" class="text-fg font-medium">
                Hide NSFW
              </h2>
              <p class="text-sm text-fg-muted mt-0.5">
                Blur images you've rated as Questionable or Explicit.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSwitch
              v-model="hideNSFW"
              aria-labelledby="setting-hide-nsfw"
              on-icon="i-tabler-eyeglass-filled"
            />
          </div>
        </div>
      </section>

      <section
        aria-labelledby="setting-arthash"
        class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong"
      >
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-photo-shield text-lg text-fg-muted mt-0.5" aria-hidden="true" />
            <div>
              <h2 id="setting-arthash" class="text-fg font-medium">
                Arthash Placeholder
              </h2>
              <p class="text-sm text-fg-muted mt-0.5">
                Show the arthash mosaic while images load. Turn this off for a plain dominant-color background that fades into the image. Set <code translate="no" class="text-fg font-mono">DISABLE_ARTHASH=1</code> on the server to also skip computing arthash for new images.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSwitch
              v-model="enableArthash"
              aria-labelledby="setting-arthash"
              on-icon="i-tabler-photo-shield"
            />
          </div>
        </div>
      </section>

      <section
        v-if="enableArthash"
        aria-labelledby="setting-fancy-placeholder"
        class="px-5 py-4 border border-border-default rounded-lg bg-surface-1 transition-colors hover:border-border-strong"
      >
        <div class="flex flex-col gap-3 md:flex-row md:gap-6 md:items-center md:justify-between">
          <div class="flex gap-3 items-start">
            <i class="i-tabler-sparkles text-lg text-fg-muted mt-0.5" aria-hidden="true" />
            <div>
              <h2 id="setting-fancy-placeholder" class="text-fg font-medium">
                Fancy Placeholder
              </h2>
              <p class="text-sm text-fg-muted mt-0.5">
                Dissolve the arthash placeholder shape-by-shape as the image loads. Turn this off for a plain fade instead — cheaper on the GPU.
              </p>
            </div>
          </div>
          <div class="flex items-center">
            <PSwitch
              v-model="enableFancyPlaceholder"
              aria-labelledby="setting-fancy-placeholder"
              on-icon="i-tabler-sparkles"
            />
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
