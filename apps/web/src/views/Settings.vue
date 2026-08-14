<script setup lang="ts">
import { enableArthash, enableFancyPlaceholder, hideNSFW } from '@/shared'
</script>

<template>
  <main class="mx-auto px-6 py-8 max-w-3xl">
    <div class="mb-8 flex gap-3 items-center">
      <i class="i-tabler-settings text-xl text-fg-muted" aria-hidden="true" />
      <h1 class="text-2xl text-fg tracking-tight font-semibold">
        {{ $t('settings.title') }}
      </h1>
    </div>

    <section aria-labelledby="settings-group-library">
      <h2 id="settings-group-library" class="text-xs text-fg-subtle tracking-wider font-medium mb-2 px-1 uppercase">
        {{ $t('settings.library') }}
      </h2>
      <div class="border border-border-default rounded-lg bg-surface-1 divide-border-default divide-y">
        <ImportFromUrlSection />
      </div>
    </section>

    <section aria-labelledby="settings-group-appearance" class="mt-8">
      <h2 id="settings-group-appearance" class="text-xs text-fg-subtle tracking-wider font-medium mb-2 px-1 uppercase">
        {{ $t('settings.appearance') }}
      </h2>
      <div class="border border-border-default rounded-lg bg-surface-1 divide-border-default divide-y">
        <SettingRow
          label-id="setting-language"
          icon="i-tabler-language"
          :title="$t('settings.language')"
          :description="$t('settings.languageDesc')"
        >
          <PLocaleSwitch />
        </SettingRow>

        <SettingRow
          label-id="setting-color-scheme"
          icon="i-tabler-palette"
          :title="$t('settings.colorScheme')"
        >
          <PSchemeSwitch />
        </SettingRow>

        <SettingRow
          label-id="setting-hide-nsfw"
          icon="i-tabler-eyeglass-filled"
          :title="$t('settings.hideNsfw')"
          :description="$t('settings.hideNsfwDesc')"
        >
          <PSwitch
            v-model="hideNSFW"
            aria-labelledby="setting-hide-nsfw"
            on-icon="i-tabler-eyeglass-filled"
          />
        </SettingRow>

        <SettingRow
          label-id="setting-arthash"
          icon="i-tabler-photo-shield"
          :title="$t('settings.arthash')"
          :description="$t('settings.arthashDesc')"
        >
          <PSwitch
            v-model="enableArthash"
            aria-labelledby="setting-arthash"
            on-icon="i-tabler-photo-shield"
          />
        </SettingRow>

        <SettingRow
          v-if="enableArthash"
          child
          label-id="setting-fancy-placeholder"
          icon="i-tabler-sparkles"
          :title="$t('settings.fancyPlaceholder')"
          :description="$t('settings.fancyPlaceholderDesc')"
        >
          <PSwitch
            v-model="enableFancyPlaceholder"
            aria-labelledby="setting-fancy-placeholder"
            on-icon="i-tabler-sparkles"
          />
        </SettingRow>
      </div>
    </section>
  </main>
</template>
