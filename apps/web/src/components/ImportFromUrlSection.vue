<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { v2ImportFromUrlStatus } from '@/api'
import { describeAPIError } from '@/composables/useAPIError'
import { startUrlImport } from '@/shared/mutations'
import { queryKeys } from '@/shared/queryKeys'

const url = ref('')
const queryClient = useQueryClient()

const statusQuery = useQuery({
  queryKey: queryKeys.urlImportStatus,
  queryFn: async () => {
    const resp = await v2ImportFromUrlStatus({})
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  // Poll while the background task runs; idle/done/failed needs no polling.
  refetchInterval: query => (query.state.data?.state === 'running' ? 2000 : false),
})

const status = computed(() => statusQuery.data.value)
const isRunning = computed(() => status.value?.state === 'running')
const urlValid = computed(() => /^https?:\/\/\S+$/.test(url.value.trim()))

const mutation = useMutation({
  // startUrlImport refreshes the status query, which then polls while running.
  mutationFn: () => startUrlImport(queryClient, url.value.trim()),
})
const busy = computed(() => isRunning.value || mutation.isPending.value)

// A failed start is about the import as it stood then. Once the polled status
// moves on (another import started, or one finished) that error no longer
// describes what is on screen, so drop it; mutate() clears it on a new start.
// Keyed on the task, not each poll: a start refused because one is already
// running keeps its explanation while that run goes on.
watch([() => status.value?.state, () => status.value?.url, () => status.value?.startedAt], () => {
  if (mutation.error.value && !mutation.isPending.value) {
    mutation.reset()
  }
})

// New images land under <category>/<creator>/ — refresh the folder tree and
// gallery once the background task finishes.
watch(() => status.value?.state, (next, prev) => {
  if (prev === 'running' && next === 'done') {
    queryClient.invalidateQueries({ queryKey: queryKeys.folders })
    queryClient.invalidateQueries({ queryKey: queryKeys.postsRoot })
  }
})

// IME: the Enter that commits a composition is not a submit.
function onEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) {
    return
  }
  e.preventDefault()
  onImport()
}

function onImport() {
  if (!urlValid.value || busy.value) {
    return
  }
  mutation.mutate()
}
</script>

<template>
  <div class="px-5 py-4">
    <div class="flex gap-3 items-start">
      <i class="i-tabler-cloud-download text-lg text-fg-muted mt-0.5" aria-hidden="true" />
      <div class="flex-grow min-w-0">
        <h3 id="setting-import-from-url" class="text-fg font-medium">
          {{ $t('import.title') }}
        </h3>
        <p id="setting-import-from-url-desc" class="text-sm text-fg-muted mt-0.5 text-pretty">
          {{ $t('import.desc') }}
        </p>

        <div class="mt-3 flex gap-2 items-center">
          <PInput
            v-model="url"
            block
            size="sm"
            type="url"
            inputmode="url"
            placeholder="https://kemono.cr/patreon/user/12345"
            :spellcheck="false"
            autocomplete="off"
            aria-labelledby="setting-import-from-url"
            aria-describedby="setting-import-from-url-desc"
            :disabled="isRunning"
            @keydown.enter="onEnter"
          />
          <PButton
            size="sm"
            variant="primary"
            :disabled="!urlValid || busy"
            @click="onImport"
          >
            <i
              v-if="busy"
              class="i-svg-spinners-90-ring-with-bg"
              aria-hidden="true"
            />
            <i v-else class="i-tabler-download" aria-hidden="true" />
            {{ $t('import.button') }}
          </PButton>
        </div>

        <!-- Persistent live region: it must exist before its content changes,
             or the running → done transition is never announced. -->
        <div role="status" aria-live="polite">
          <div v-if="status && status.state !== 'idle'" class="text-sm mt-3">
            <div v-if="status.state === 'running'" class="text-fg-muted flex gap-2 items-center">
              <i class="i-svg-spinners-90-ring-with-bg shrink-0" aria-hidden="true" />
              <i18n-t keypath="import.importing" tag="span" scope="global" class="min-w-0 truncate">
                <template #url>
                  <code translate="no" class="text-fg font-mono">{{ status.url }}</code>
                </template>
              </i18n-t>
            </div>

            <div v-else-if="status.state === 'done'" class="space-y-1">
              <div class="text-fg flex gap-2 items-center">
                <i class="i-tabler-circle-check text-success shrink-0" aria-hidden="true" />
                <i18n-t keypath="import.imported" tag="span" scope="global" class="min-w-0 truncate">
                  <template #url>
                    <code translate="no" class="text-fg font-mono">{{ status.url }}</code>
                  </template>
                </i18n-t>
              </div>
              <div class="text-xs text-fg-muted pl-6 tabular-nums">
                {{ $t('import.statFetched') }} {{ status.stats?.fetched }} · {{ $t('import.statImages') }} {{ status.stats?.images }} · {{ $t('import.statNew') }} {{ status.stats?.new }} · {{ $t('import.statDownloaded') }} {{ status.stats?.downloaded }} · {{ $t('import.statFailed') }} {{ status.stats?.failed }}
              </div>
              <i18n-t v-if="status.stats?.fetched === 0" keypath="import.noEntries" tag="p" scope="global" class="text-warning pl-6">
                <template #conf>
                  <code translate="no" class="font-mono">.pictoria/gallery-dl.conf</code>
                </template>
              </i18n-t>
              <p v-if="(status.stats?.failed ?? 0) > 0" class="text-warning pl-6">
                {{ $t('import.failedRetry', { n: status.stats?.failed ?? 0 }, status.stats?.failed ?? 0) }}
              </p>
              <p class="text-fg-subtle pl-6">
                {{ $t('import.metadataSync') }}
              </p>
            </div>

            <div v-else-if="status.state === 'failed'" class="text-danger flex gap-2 items-start">
              <i class="i-tabler-alert-circle mt-0.5 shrink-0" aria-hidden="true" />
              <span class="min-w-0 break-all">{{ $t('import.failed', { error: status.error }) }}</span>
            </div>
          </div>
        </div>
        <p v-if="mutation.error.value" role="alert" class="text-sm text-danger mt-2">
          {{ describeAPIError(mutation.error.value) }}
        </p>
      </div>
    </div>
  </div>
</template>
