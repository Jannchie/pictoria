<script setup lang="tsx">
import { SchemeSwitch, Switch } from '@roku-ui/vue'
import { hideNSFW } from '@/shared'
</script>

<template>
  <div class="mx-auto px-4 py-6 container max-w-3xl">
    <h2 class="border-surface-200 dark:border-surface-700 text-2xl font-semibold mb-8 pb-3 border-b">
      Settings
    </h2>

    <div class="space-y-8">
      <!-- Color Scheme Section -->
      <section class="bg-surface-50 dark:bg-surface-800 p-6 rounded-lg shadow-sm">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between">
          <div class="mb-4 md:mb-0">
            <h3 class="text-surface-900 dark:text-surface-100 text-lg font-medium">
              Color Scheme
            </h3>
            <p class="text-surface-600 dark:text-surface-400 text-sm mt-1">
              Change color scheme of the application.
            </p>
          </div>
          <div class="flex items-center">
            <SchemeSwitch />
          </div>
        </div>
      </section>

      <!-- Hide NSFW Section -->
      <section class="bg-surface-50 dark:bg-surface-800 p-6 rounded-lg shadow-sm">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between">
          <div class="mb-4 md:mb-0">
            <h3 class="text-surface-900 dark:text-surface-100 text-lg font-medium">
              Hide NSFW
            </h3>
            <p class="text-surface-600 dark:text-surface-400 text-sm mt-1">
              Blur Not Safe For Work content.
            </p>
          </div>
          <div class="flex items-center">
            <Switch
              v-model="hideNSFW"
              on-icon="i-tabler-eyeglass-filled"
            />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
