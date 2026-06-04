<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { v2ImportFromUrlEndpoint, v2ImportFromUrlStatus } from '@/api'
import { describeAPIError } from '@/composables/useAPIError'
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
  mutationFn: async () => {
    const resp = await v2ImportFromUrlEndpoint({ query: { url: url.value.trim() } })
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  onSuccess: () => {
    statusQuery.refetch()
  },
})

// New images land under <category>/<creator>/ — refresh the folder tree and
// gallery once the background task finishes.
watch(() => status.value?.state, (next, prev) => {
  if (prev === 'running' && next === 'done') {
    queryClient.invalidateQueries({ queryKey: queryKeys.folders })
    queryClient.invalidateQueries({ queryKey: queryKeys.postsRoot })
  }
})

function onImport() {
  if (!urlValid.value || isRunning.value) {
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
          Import from URL
        </h3>
        <p class="text-sm text-fg-muted mt-0.5 text-pretty">
          Fetch new images from a gallery-dl compatible URL — Kemono pages, Booru searches and more.
        </p>

        <div class="mt-3 flex gap-2 items-center">
          <PInput
            v-model="url"
            class="flex-grow"
            size="sm"
            type="url"
            inputmode="url"
            placeholder="https://kemono.cr/patreon/user/12345"
            :spellcheck="false"
            autocomplete="off"
            aria-labelledby="setting-import-from-url"
            :disabled="isRunning"
            @keydown.enter="onImport"
          />
          <PButton
            size="sm"
            variant="primary"
            :disabled="!urlValid || isRunning"
            @click="onImport"
          >
            <i
              v-if="isRunning || mutation.status.value === 'pending'"
              class="i-svg-spinners-90-ring-with-bg"
              aria-hidden="true"
            />
            <i v-else class="i-tabler-download" aria-hidden="true" />
            Import
          </PButton>
        </div>

        <div v-if="status && status.state !== 'idle'" class="text-sm mt-3" aria-live="polite">
          <div v-if="status.state === 'running'" class="text-fg-muted flex gap-2 items-center">
            <i class="i-svg-spinners-90-ring-with-bg shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate">
              Importing <code translate="no" class="text-fg font-mono">{{ status.url }}</code> — runs in the background.
            </span>
          </div>

          <div v-else-if="status.state === 'done'" class="space-y-1">
            <div class="text-fg flex gap-2 items-center">
              <i class="i-tabler-circle-check text-success shrink-0" aria-hidden="true" />
              <span class="min-w-0 truncate">
                Imported <code translate="no" class="text-fg font-mono">{{ status.url }}</code>
              </span>
            </div>
            <div class="text-xs text-fg-muted font-mono pl-6">
              fetched {{ status.stats?.fetched }} · images {{ status.stats?.images }} · new {{ status.stats?.new }} · downloaded {{ status.stats?.downloaded }} · failed {{ status.stats?.failed }}
            </div>
            <p v-if="status.stats?.fetched === 0" class="text-warning pl-6">
              No entries found — check the URL, or the site may need cookies in <code translate="no" class="font-mono">.pictoria/gallery-dl.conf</code>.
            </p>
            <p v-if="(status.stats?.failed ?? 0) > 0" class="text-warning pl-6">
              {{ status.stats?.failed }} download(s) failed — import again to retry (see server logs).
            </p>
            <p v-if="status.syncTriggered" class="text-fg-subtle pl-6">
              Metadata sync started — tags and scores will fill in shortly.
            </p>
          </div>

          <div v-else-if="status.state === 'failed'" class="text-danger flex gap-2 items-start">
            <i class="i-tabler-alert-circle mt-0.5 shrink-0" aria-hidden="true" />
            <span class="min-w-0 break-all">Import failed: {{ status.error }}</span>
          </div>
        </div>
        <p v-if="mutation.error.value" class="text-sm text-danger mt-2">
          {{ describeAPIError(mutation.error.value) }}
        </p>
      </div>
    </div>
  </div>
</template>
