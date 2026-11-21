import { describe, expect, it } from 'vitest'
import {
  QUARANTINED_VARIANT_GROUPS, VARIANT_SIBLING_CAP, normalizeSeriesSelection, parseSeriesParam, seriesBelongsToBrands,
} from './series-facet-contract'

describe('series facet contract (#432)', () => {
  it('parses comma and repeated params, de-duplicates and reports malformed values', () => {
    expect(parseSeriesParam('toto-gf-series,toto-ge-series,toto-gf-series')).toEqual({ slugs: ['toto-gf-series', 'toto-ge-series'], invalid: [] })
    expect(parseSeriesParam(['toto-gf-series', 'inax-s600-line'])).toEqual({ slugs: ['toto-gf-series', 'inax-s600-line'], invalid: [] })
    expect(parseSeriesParam('TOTO GF,../x,;drop')).toEqual({ slugs: [], invalid: ['TOTO GF', '../x', ';drop'] })
    expect(parseSeriesParam(undefined)).toEqual({ slugs: [], invalid: [] })
  })

  it('caps the number of selected series', () => {
    const many = Array.from({ length: 30 }, (_, i) => `toto-s${i}-series`).join(',')
    const parsed = parseSeriesParam(many)
    expect(parsed.slugs).toHaveLength(16)
    expect(parsed.invalid).toHaveLength(14)
  })

  it('a series belongs to a brand only by its namespace prefix, never by substring', () => {
    expect(seriesBelongsToBrands('toto-gf-series', ['toto'])).toBe(true)
    expect(seriesBelongsToBrands('toto-gf-series', ['inax'])).toBe(false)
    expect(seriesBelongsToBrands('totoro-gf-series', ['toto'])).toBe(false)
  })

  it('drops tags when no brand is selected or the brand changed (reset on brand change)', () => {
    expect(normalizeSeriesSelection([], ['toto-gf-series'])).toEqual({ accepted: [], dropped: ['toto-gf-series'] })
    expect(normalizeSeriesSelection(['inax'], ['toto-gf-series', 'inax-s600-line'])).toEqual({ accepted: ['inax-s600-line'], dropped: ['toto-gf-series'] })
    expect(normalizeSeriesSelection(['toto', 'inax'], ['toto-gf-series', 'inax-s600-line']).dropped).toEqual([])
  })

  it('keeps the reviewed-wrong groups quarantined and the sibling cap well above the old limit of 8', () => {
    for (const group of ['TBW0', 'TBW01001B', 'TBG02302', 'TBG08302']) expect(QUARANTINED_VARIANT_GROUPS).toContain(group)
    expect(VARIANT_SIBLING_CAP).toBeGreaterThanOrEqual(20)
  })
})
