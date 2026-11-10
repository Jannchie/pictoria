import { describe, expect, it } from 'vitest'
import { fileIconClass } from '@/utils/fileIcon'

describe('fileiconclass', () => {
  it('maps each family to its icon', () => {
    expect(fileIconClass('flac')).toBe('i-tabler-music')
    expect(fileIconClass('mkv')).toBe('i-tabler-video')
    expect(fileIconClass('7z')).toBe('i-tabler-archive')
    expect(fileIconClass('pdf')).toBe('i-tabler-file-type-pdf')
    expect(fileIconClass('docx')).toBe('i-tabler-file-word')
    expect(fileIconClass('xls')).toBe('i-tabler-file-excel')
    expect(fileIconClass('pptx')).toBe('i-tabler-file-type-ppt')
    expect(fileIconClass('txt')).toBe('i-tabler-file-text')
    expect(fileIconClass('htm')).toBe('i-tabler-file-code')
    expect(fileIconClass('json')).toBe('i-tabler-file-code')
  })

  it('falls back to a generic file icon', () => {
    expect(fileIconClass('psd')).toBe('i-tabler-file')
    expect(fileIconClass('')).toBe('i-tabler-file')
  })
})
