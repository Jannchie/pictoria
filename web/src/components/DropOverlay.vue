<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query'
import { useRoute } from 'vue-router'
import { v2UploadFile } from '@/api'

const dropZoneRef = ref<HTMLElement | null>(null)
const isDraggingFiles = ref(false)
const dragEnterCount = ref(0)
const queryClient = useQueryClient()

async function onUploadFile(file: File, path: string | null, source?: string) {
  try {
    await v2UploadFile({
      body: {
        file,
        path,
        source,
      },
    })
    queryClient.invalidateQueries({ queryKey: ['posts'] })
  }
  catch (error) {
    console.error(error)
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
      await onUploadFile(file, path, source)
    }
    else if (entry.isDirectory) {
      // 递归处理子文件夹
      await readDirectory(entry as FileSystemDirectoryEntry, path, source)
    }
  }
}
useEventListener(globalThis, 'drop', async (event: DragEvent) => {
  event.preventDefault()
  dragEnterCount.value = 0
  isDraggingFiles.value = false
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
            await onUploadFile(file, null, source)
          }
          else if (entry.isDirectory) {
            const folderName = entry.name
            const folder = baseFolder.value ? `${baseFolder.value}/${folderName}` : folderName
            await readDirectory(entry as FileSystemDirectoryEntry, folder, source)
          }
        }
      }
      catch (error) {
        console.error(error)
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

globalThis.addEventListener('dragover', (e) => {
  e.preventDefault()
}, false)

useEventListener(globalThis, 'dragend', () => {
  dragEnterCount.value = 0
})

useEventListener(globalThis, 'dragenter', (event: DragEvent) => {
  dragEnterCount.value++
  isDraggingFiles.value = !!event.dataTransfer?.types.includes('Files')
}, {
  passive: true,
  capture: true,
})
useEventListener(globalThis, 'dragleave', (event: DragEvent) => {
  dragEnterCount.value--
  isDraggingFiles.value = !!event.dataTransfer?.types.includes('Files')
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
    class="text-lg bg-primary-5/25 flex h-100vh w-100vw pointer-events-none items-center justify-center fixed z-10"
  >
    <div class="text-black">
      Drop files here to save them.
    </div>
  </div>
</template>
