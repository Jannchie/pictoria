<script setup lang="tsx">
import { hideNSFW } from '@/shared'
import { SchemeSwitch, Switch } from '@roku-ui/vue'
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-6 container">
    <h2 class="border-surface-200 dark:border-surface-700 mb-8 border-b pb-3 text-2xl font-semibold">
      Settings
    </h2>

    <div class="space-y-8">
      <!-- Color Scheme Section -->
      <section class="bg-surface-50 dark:bg-surface-800 rounded-lg p-6 shadow-sm">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between">
          <div class="mb-4 md:mb-0">
            <h3 class="text-surface-900 dark:text-surface-100 text-lg font-medium">
              Color Scheme
            </h3>
            <p class="text-surface-600 dark:text-surface-400 mt-1 text-sm">
              Change color scheme of the application.
            </p>
          </div>
          <div class="flex items-center">
            <SchemeSwitch />
          </div>
        </div>
      </section>

      <!-- Hide NSFW Section -->
      <section class="bg-surface-50 dark:bg-surface-800 rounded-lg p-6 shadow-sm">
        <div class="flex flex-col md:flex-row md:items-center md:justify-between">
          <div class="mb-4 md:mb-0">
            <h3 class="text-surface-900 dark:text-surface-100 text-lg font-medium">
              Hide NSFW
            </h3>
            <p class="text-surface-600 dark:text-surface-400 mt-1 text-sm">
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
