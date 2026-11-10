import { describe, expect, it } from 'vitest'
import { formatDate } from '@/locale'
import { RATING_LEVEL_COLORS, RATING_LEVEL_ICONS, SCORE_LEVEL_COLORS, waifuLevelRgb } from '@/shared/ratings'
import { formatSortValue } from '@/utils/sortBadge'

describe('formatsortvalue', () => {
  it('score shows the number in its level colour', () => {
    expect(formatSortValue('score', 4)).toEqual({ text: '4', color: SCORE_LEVEL_COLORS[3] })
  })

  it('rating shows the level icon, a dash out of range', () => {
    expect(formatSortValue('rating', 2)).toEqual({ icon: RATING_LEVEL_ICONS[1], color: RATING_LEVEL_COLORS[1] })
    expect(formatSortValue('rating', 0)).toEqual({ text: '—' })
    expect(formatSortValue('rating', RATING_LEVEL_ICONS.length + 1)).toEqual({ text: '—' })
  })

  it('waifu is 0–10, silva heads are scaled from 0–1', () => {
    expect(formatSortValue('waifu_score', 7.256)).toEqual({ text: '7.26', color: `rgb(${waifuLevelRgb(7.256)})` })
    expect(formatSortValue('silva_score', 0.5)).toEqual({ text: '5.00', color: `rgb(${waifuLevelRgb(5)})` })
    expect(formatSortValue('silva_luna_score', '0.25')).toEqual({ text: '2.50', color: `rgb(${waifuLevelRgb(2.5)})` })
  })

  it('discrepancy uses the danger token', () => {
    expect(formatSortValue('discrepancy', 1.5)).toEqual({ text: '1.50', color: 'var(--p-danger)' })
  })

  it('date columns are formatted, colourless', () => {
    const iso = '2026-01-02T03:04:05Z'
    for (const sort of ['created_at', 'published_at', 'updated_at', 'last_accessed_at']) {
      expect(formatSortValue(sort, iso)).toEqual({ text: formatDate(iso) })
    }
  })

  it('id and file_name get no badge', () => {
    expect(formatSortValue('id', 12)).toBeUndefined()
    expect(formatSortValue('file_name', 'a')).toBeUndefined()
  })
})
