import { describe, expect, it } from 'vitest'
import { labToRgbaString } from '@/utils/color'
import { converter, parse } from '@/utils/culori'

// Pins the `culori/fn` slice (src/utils/culori.ts) to what the full `culori`
// build returned for the same calls — the expected values were dumped from
// `culori` itself. This file must not import full `culori`: it would register
// every mode and hide a missing `useMode` here.

describe('culori/fn slice matches the full build', () => {
  it('parses css colours and converts them to lab (the sort-colour path)', () => {
    const toLab = converter('lab')
    const cases: [string, number, number, number][] = [
      ['#ff0000', 54.290_542_946_969_68, 80.804_920_334_624_17, 69.890_988_258_962_78],
      ['#9a76c2', 55.530_279_679_775_16, 25.850_276_599_697_132, -34.739_260_114_776_04],
      ['#123456', 20.675_469_335_418_285, -2.276_788_949_266_612, -24.593_148_412_149_2],
      ['#ffffff', 100.000_001_396_496_32, 0, 0],
      ['#000000', 0, 0, 0],
      ['rgb(10 200 30)', 70.561_099_959_893_55, -64.999_852_473_579_75, 63.337_724_623_871_075],
      ['hsl(210 50% 40%)', 41.520_823_889_928_906, -4.573_085_811_610_089, -33.494_193_705_724_975],
      ['red', 54.290_542_946_969_68, 80.804_920_334_624_17, 69.890_988_258_962_78],
    ]
    for (const [input, l, a, b] of cases) {
      expect(toLab(parse(input)), input).toEqual({ mode: 'lab', l, a, b })
    }
  })

  it('formats lab as css rgb (the dominant-colour path)', () => {
    expect(labToRgbaString(50, 20, -30)).toBe('rgb(133, 108, 170)')
    expect(labToRgbaString(75.5, -10.25, 40, 0.5)).toBe('rgba(187, 191, 110, 0.5)')
    expect(labToRgbaString(0, 0, 0)).toBe('rgb(0, 0, 0)')
    expect(labToRgbaString(100, 0, 0)).toBe('rgb(255, 255, 255)')
    expect(labToRgbaString(30, 60, 60)).toBe('rgb(153, 0, 0)')
  })
})
