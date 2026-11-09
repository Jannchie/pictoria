<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useAPIError } from '@/composables/useAPIError'
import { announce } from '@/shared/announce'
import { uploadFile } from '@/shared/mutations'

const { t } = useI18n()
const { handle: handleAPIError } = useAPIError()

// The drag in progress. dragenter / dragleave fire for every element crossed,
// so `depth` counts unmatched enters (clamped at 0: a leave can arrive without
// its enter, e.g. a drag that started inside the page); `files` is whether the
// payload is files at all. Drop and dragend end it outright.
interface DragState { depth: number, files: boolean }
const IDLE: DragState = { depth: 0, files: false }
const drag = ref<DragState>(IDLE)
const queryClient = useQueryClient()

/**
 * One drop's uploads. Each drop gets its own: a second drop while the first is
 * still uploading must not reset the first one's count, or its "N saved"
 * announcement comes out wrong. Failures surface as error toasts instead.
 */
interface DropUpload { saved: number }

async function onUploadFile(upload: DropUpload, file: File, path: string | null, source?: string) {
  try {
    await uploadFile(queryClient, { file, path, source })
    upload.saved++
  }
  catch (error) {
    handleAPIError(error, t('error.uploadFailed'))
  }
}

const route = useRoute()
const baseFolder = computed(() => {
  if (route.name === 'dir') {
    if (Array.isArray(route.params.folder)) {
      if (route.params.folder.includes('@')) {
        return null
      }
      return route.params.folder.join('/')
    }
    return route.params.folder
  }
  return null
})

async function readDirectory(upload: DropUpload, directoryEntry: FileSystemDirectoryEntry, path: string | null, source?: string) {
  const reader = directoryEntry.createReader()
  let entries: FileSystemEntry[] = []

  const readEntries = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      reader.readEntries((results) => {
        if (results.length > 0) {
          resolve(results)
        }
        else {
          resolve([])
        }
      }, reject)
    })
  }

  let batch: FileSystemEntry[] = []

  do {
    batch = await readEntries()
    entries = [...entries, ...batch]
  } while (batch.length > 0)
  for (const entry of entries) {
    if (entry.isFile) {
      // 处理文件
      const file = await new Promise<File>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve)
      })
      await onUploadFile(upload, file, path, source)
    }
    else if (entry.isDirectory) {
      // 递归处理子文件夹
      await readDirectory(upload, entry as FileSystemDirectoryEntry, path, source)
    }
  }
}
useEventListener(globalThis, 'drop', async (event: DragEvent) => {
  event.preventDefault()
  drag.value = IDLE
  const upload: DropUpload = { saved: 0 }
  const source = event.dataTransfer?.getData('text/uri-list')
  const entries = [...event.dataTransfer?.items ?? []].map(item => item.webkitGetAsEntry())
  if (entries) {
    for (const entry of entries) {
      try {
        if (entry) {
          if (entry.isFile) {
            // 文件
            const file = await new Promise<File>((resolve) => {
              (entry as FileSystemFileEntry).file(resolve)
            })
            await onUploadFile(upload, file, null, source)
          }
          else if (entry.isDirectory) {
            const folderName = entry.name
            const folder = baseFolder.value ? `${baseFolder.value}/${folderName}` : folderName
            await readDirectory(upload, entry as FileSystemDirectoryEntry, folder, source)
          }
        }
      }
      catch (error) {
        handleAPIError(error, t('error.uploadFailed'))
      }
    }
  }
  if (event.dataTransfer?.files) {
    for (const file of event.dataTransfer.files) {
      await onUploadFile(upload, file, baseFolder.value, source)
    }
  }
  if (upload.saved > 0) {
    announce(t('dropOverlay.saved', { n: upload.saved }, upload.saved))
  }
}, {
  passive: false,
  capture: true,
})

useEventListener(globalThis, 'dragover', (e: DragEvent) => {
  e.preventDefault()
})

useEventListener(globalThis, 'dragend', () => {
  drag.value = IDLE
})

const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')
useEventListener(globalThis, 'dragenter', (event: DragEvent) => {
  drag.value = { depth: drag.value.depth + 1, files: carriesFiles(event) }
}, {
  passive: true,
  capture: true,
})
useEventListener(globalThis, 'dragleave', (event: DragEvent) => {
  const depth = Math.max(0, drag.value.depth - 1)
  drag.value = depth === 0 ? IDLE : { depth, files: carriesFiles(event) }
}, {
  passive: true,
  capture: true,
})

// Hidden = out of the accessibility tree too (it used to be only op-0, so a
// screen reader read the hint at all times). Showing it announces the hint
// once through the shared live region: flipping aria-hidden and inserting a
// role=status in the same frame is read unreliably.
// `files` is only ever set with depth > 0 (depth 0 resets to IDLE).
const visible = computed(() => drag.value.files)
watch(visible, (v) => {
  if (v) {
    announce(t('dropOverlay.hint'))
  }
})
</script>

<template>
  <div
    :class="{
      'op-0': !visible,
    }"
    :aria-hidden="!visible || undefined"
    :inert="!visible || undefined"
    class="text-lg bg-primary/25 flex h-100vh w-100vw pointer-events-none items-center justify-center fixed z-10"
  >
    <div class="text-black">
      {{ $t('dropOverlay.hint') }}
    </div>
  </div>
</template>
