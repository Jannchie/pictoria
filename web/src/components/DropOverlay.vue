<script setup lang="ts">
import { v1UploadFile } from '@/api'
import { useQueryClient } from '@tanstack/vue-query'
import { useRoute } from 'vue-router'

const dropZoneRef = ref<HTMLElement | null>(null)
const isDraggingFiles = ref(false)
const dragEnterCount = ref(0)
const queryClient = useQueryClient()

async function onUploadFile(file: File, path: string | null, source?: string) {
  try {
    await v1UploadFile({
      body: {
        file,
        path,
        source,
      },
    })
    queryClient.invalidateQueries({ queryKey: ['posts'] })
  }
  catch (e) {
    console.error(e)
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

async function readDirectory(directoryEntry: FileSystemDirectoryEntry, path: string | null, source?: string) {
  const reader = directoryEntry.createReader()
  let entries: FileSystemEntry[] = []

  const readEntries = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      reader.readEntries((results) => {
        if (results.length) {
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
    entries = entries.concat(batch)
  } while (batch.length > 0)
  for (const entry of entries) {
    if (entry.isFile) {
      // 处理文件
      const file = await new Promise<File>((resolve) => {
        (entry as FileSystemFileEntry).file(resolve)
      })
      await onUploadFile(file, path, source)
    }
    else if (entry.isDirectory) {
      // 递归处理子文件夹
      await readDirectory(entry as FileSystemDirectoryEntry, path, source)
    }
  }
}
useEventListener(window, 'drop', async (event) => {
  event.preventDefault()
  dragEnterCount.value = 0
  isDraggingFiles.value = false
  const source = event.dataTransfer?.getData('text/uri-list')
  const entries = Array.from(event.dataTransfer?.items ?? []).map(item => item.webkitGetAsEntry())
  if (entries) {
    for (const entry of entries) {
      try {
        if (entry) {
          if (entry.isFile) {
            // 文件
            const file = await new Promise<File>((resolve) => {
              (entry as FileSystemFileEntry).file(resolve)
            })
            await onUploadFile(file, null, source)
          }
          else if (entry.isDirectory) {
            const folderName = entry.name
            const folder = baseFolder.value ? `${baseFolder.value}/${folderName}` : folderName
            await readDirectory(entry as FileSystemDirectoryEntry, folder, source)
          }
        }
      }
      catch (e) {
        console.error(e)
      }
    }
  }
  if (event.dataTransfer?.files) {
    for (const file of event.dataTransfer.files) {
      await onUploadFile(file, baseFolder.value, source)
    }
  }
}, {
  passive: false,
  capture: true,
})

window.addEventListener('dragover', (e) => {
  e.preventDefault()
}, false)

useEventListener(window, 'dragend', () => {
  dragEnterCount.value = 0
})

useEventListener(window, 'dragenter', (event) => {
  dragEnterCount.value++
  if (event.dataTransfer?.types.includes('Files')) {
    isDraggingFiles.value = true
  }
  else {
    isDraggingFiles.value = false
  }
}, {
  passive: true,
  capture: true,
})
useEventListener(window, 'dragleave', (event) => {
  dragEnterCount.value--
  if (event.dataTransfer?.types.includes('Files')) {
    isDraggingFiles.value = true
  }
  else {
    isDraggingFiles.value = false
  }
}, {
  passive: true,
  capture: true,
})
</script>

<template>
  <div
    ref="dropZoneRef"
    :class="{
      'op-0': dragEnterCount === 0 || !isDraggingFiles,
    }"
    class="pointer-events-none fixed z-10 h-100vh w-100vw flex items-center justify-center bg-primary-5/25 text-lg"
  >
    <div class="text-black">
      Drop files here to save them.
    </div>
  </div>
</template>
