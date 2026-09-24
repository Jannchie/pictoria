<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
import { useStorage } from '@vueuse/core'
import { computed, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { v2GetQueuesStatus } from '@/api'
import { formatNumber } from '@/locale'
import { announce } from '@/shared/announce'
import { queryKeys } from '@/shared/queryKeys'

// Sidebar "sync status": what the backfill loops (basics / scorers / tagger /
// embedding) and the cairnq queues are doing right now. Only busy loops get a
// row — six "done" lines would be noise — so an idle library collapses to one
// "all caught up" line.

const { t } = useI18n()
const detailsId = useId()
const expanded = useStorage('pictoria.syncStatus.expanded', true)

const statusQuery = useQuery({
  queryKey: queryKeys.queuesStatus,
  queryFn: async () => {
    const resp = await v2GetQueuesStatus({})
    if (resp.error) {
      throw resp.error
    }
    return resp.data
  },
  // Poll fast while something moves, slowly otherwise so a new import still
  // shows up within a few seconds of the loops noticing it.
  refetchInterval: query => (query.state.data?.loops.some(l => l.state !== 'idle') ? 3000 : 15_000),
})

const status = computed(() => statusQuery.data.value)
const active = computed(() => status.value?.loops.filter(l => l.state !== 'idle') ?? [])
const hasError = computed(() => active.value.some(l => l.state === 'error'))
const schedulerDown = computed(() => status.value !== undefined && !status.value.scheduler.running)
const busyQueues = computed(() => status.value?.queues.filter(q => q.running + q.queued > 0) ?? [])

// The slowest loop decides when the library is fully processed.
const overallEta = computed(() => {
  const etas = active.value.map(l => l.etaSeconds).filter((s): s is number => s !== null)
  return etas.length > 0 ? Math.max(...etas) : null
})

// Loop keys and queue names come from the API; both map to message keys here
// (their key spaces don't overlap). Anything unknown shows as-is.
const LABEL_KEY: Record<string, string> = {
  'basics': 'syncStatus.loop.basics',
  'silva': 'syncStatus.loop.silva',
  'silva_luna': 'syncStatus.loop.silvaLuna',
  'waifu': 'syncStatus.loop.waifu',
  'tagger': 'syncStatus.loop.tagger',
  'embedding': 'syncStatus.loop.embedding',
  'gpu': 'syncStatus.queue.gpu',
  'gpu-interactive': 'syncStatus.queue.gpuInteractive',
  'io': 'syncStatus.queue.io',
  'cpu': 'syncStatus.queue.cpu',
}

function label(name: string): string {
  const labelKey = LABEL_KEY[name]
  return labelKey ? t(labelKey) : name
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) {
    return t('syncStatus.duration.lessThanMinute')
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 1) {
    return t('syncStatus.duration.minutes', { m: minutes })
  }
  const days = Math.floor(hours / 24)
  if (days < 1) {
    return t('syncStatus.duration.hoursMinutes', { h: hours, m: minutes % 60 })
  }
  return t('syncStatus.duration.daysHours', { d: days, h: hours % 24 })
}

function formatRate(perSecond: number): string {
  // Below one a second, per-minute reads better than "0.3/s".
  return perSecond >= 1
    ? t('syncStatus.ratePerSecond', { rate: formatNumber(Math.round(perSecond * 10) / 10) })
    : t('syncStatus.ratePerMinute', { rate: formatNumber(Math.round(perSecond * 60)) })
}

// Screen readers hear the coarse state *changes* (started / finished / failed /
// scheduler down) — not every poll's counts, which would never stop talking.
const LIVE_KEY = {
  working: 'syncStatus.live.working',
  done: 'syncStatus.live.done',
  down: 'syncStatus.live.down',
  error: 'syncStatus.live.error',
} as const
const liveState = computed<keyof typeof LIVE_KEY | null>(() => {
  if (!status.value) {
    return null
  }
  if (schedulerDown.value) {
    return 'down'
  }
  if (hasError.value) {
    return 'error'
  }
  return active.value.length > 0 ? 'working' : 'done'
})
watch(liveState, (state, previous) => {
  if (state && previous) {
    announce(t(LIVE_KEY[state]), state === 'down' || state === 'error' ? 'assertive' : 'polite')
  }
})

// One view model per busy loop, so the template reads each derived value once.
const rows = computed(() => active.value.map((loop) => {
  const total = loop.remaining === null ? 0 : loop.sessionDone + loop.remaining
  const detail = [
    loop.ratePerSecond === null ? null : formatRate(loop.ratePerSecond),
    loop.etaSeconds === null ? null : t('syncStatus.eta', { time: formatDuration(loop.etaSeconds) }),
  ].filter(Boolean).join(' · ')
  return {
    ...loop,
    label: label(loop.key),
    // Share of this busy stretch that is done; null until the remaining count lands.
    percent: total > 0 ? Math.round(loop.sessionDone / total * 100) : null,
    detail,
  }
}))
</script>

<template>
  <div v-if="status" class="px-2 pt-2">
    <button
      type="button"
      class="text-xs px-2 py-1 rounded flex gap-2 w-full transition-colors items-center hover:bg-surface-2"
      :aria-expanded="expanded"
      :aria-controls="detailsId"
      :title="t('syncStatus.toggle')"
      @click="expanded = !expanded"
    >
      <i
        v-if="schedulerDown || hasError"
        class="i-tabler-alert-triangle text-danger shrink-0"
        aria-hidden="true"
      />
      <i
        v-else-if="active.length > 0"
        class="i-svg-spinners-90-ring-with-bg text-primary shrink-0"
        aria-hidden="true"
      />
      <i
        v-else
        class="i-tabler-circle-check text-success shrink-0"
        aria-hidden="true"
      />
      <span class="text-fg-muted text-left flex-1 truncate">
        <template v-if="schedulerDown">{{ t('syncStatus.schedulerDown') }}</template>
        <template v-else-if="active.length > 0">{{ t('syncStatus.working', { n: active.length }, active.length) }}</template>
        <template v-else>{{ t('syncStatus.allDone') }}</template>
      </span>
      <span
        v-if="!expanded && overallEta !== null"
        class="text-fg-subtle shrink-0 tabular-nums"
      >{{ t('syncStatus.eta', { time: formatDuration(overallEta) }) }}</span>
      <i
        class="i-tabler-chevron-down text-fg-subtle shrink-0 h-3.5 w-3.5 transition-transform"
        :class="{ '-rotate-90': !expanded }"
        aria-hidden="true"
      />
    </button>

    <div
      v-show="expanded"
      :id="detailsId"
      class="px-2 pb-1 flex flex-col gap-2"
    >
      <p
        v-if="schedulerDown && status.scheduler.error"
        class="text-2xs text-danger break-words"
      >
        {{ t('syncStatus.schedulerDownHint', { error: status.scheduler.error }) }}
      </p>

      <div
        v-for="loop in rows"
        :key="loop.key"
        class="flex flex-col gap-1"
      >
        <div class="text-xs flex gap-2 items-baseline">
          <span class="text-fg flex-1 truncate">{{ loop.label }}</span>
          <span class="text-fg-muted shrink-0 tabular-nums">
            {{ loop.remaining === null ? t('syncStatus.counting') : t('syncStatus.remaining', { n: formatNumber(loop.remaining) }) }}
          </span>
        </div>
        <div
          class="rounded-full bg-surface-3 h-1 overflow-hidden"
          role="progressbar"
          :aria-label="loop.label"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="loop.percent ?? undefined"
          :aria-valuetext="loop.remaining === null ? t('syncStatus.counting') : t('syncStatus.remaining', { n: formatNumber(loop.remaining) })"
        >
          <div
            class="rounded-full h-full transition-[width] duration-500"
            :class="loop.state === 'error' ? 'bg-danger' : 'bg-primary'"
            :style="{ width: `${loop.percent ?? 0}%` }"
          />
        </div>
        <p
          v-if="loop.state === 'error' && loop.lastError"
          class="text-2xs text-danger truncate"
          :title="loop.lastError"
        >
          {{ t('syncStatus.lastError', { error: loop.lastError }) }}
        </p>
        <p
          v-else-if="loop.detail"
          class="text-2xs text-fg-subtle tabular-nums"
        >
          {{ loop.detail }}
        </p>
      </div>

      <p
        v-for="q in busyQueues"
        :key="q.name"
        class="text-2xs text-fg-subtle tabular-nums"
      >
        {{ t('syncStatus.queueLine', { queue: label(q.name), running: formatNumber(q.running), queued: formatNumber(q.queued) }) }}
      </p>
    </div>
  </div>
</template>
