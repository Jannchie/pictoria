// Listed in uno.config.ts's content pipeline: the icon class names below only
// exist as strings here, so UnoCSS has to scan this file to generate them.

/** Icon class for a non-image post's tile, by file extension (lower-case, no dot). */
export function fileIconClass(extension: string): string {
  switch (extension) {
    case 'mp3':
    case 'flac':
    case 'wav':
    case 'ogg': {
      return 'i-tabler-music'
    }
    case 'mp4':
    case 'webm':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'wmv':
    case 'flv': {
      return 'i-tabler-video'
    }
    case 'zip':
    case 'rar':
    case '7z':
    case 'tar':
    case 'gz':
    case 'bz2':
    case 'xz': {
      return 'i-tabler-archive'
    }
    case 'pdf': {
      return 'i-tabler-file-type-pdf'
    }
    case 'doc':
    case 'docx': {
      return 'i-tabler-file-word'
    }
    case 'xls':
    case 'xlsx': {
      return 'i-tabler-file-excel'
    }
    case 'ppt':
    case 'pptx': {
      return 'i-tabler-file-type-ppt'
    }
    case 'txt': {
      return 'i-tabler-file-text'
    }
    case 'html':
    case 'htm':
    case 'json': {
      return 'i-tabler-file-code'
    }
    default: {
      return 'i-tabler-file'
    }
  }
}
