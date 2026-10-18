import { describe, expect, it } from 'vitest'
import { addDays, addSeconds, parseUtcIso, startOfUtcDay, toUtcIso } from './time.ts'

describe('time', () => {
  it('formats as UTC ISO with Z', () => {
    expect(toUtcIso(new Date(Date.UTC(2026, 9, 3, 1, 2, 3)))).toBe('2026-10-03T01:02:03.000Z')
  })

  it('parses timestamps with an explicit zone', () => {
    expect(toUtcIso(parseUtcIso('2026-10-03T08:00:00+08:00'))).toBe('2026-10-03T00:00:00.000Z')
    expect(toUtcIso(parseUtcIso('2026-10-03T00:00:00Z'))).toBe('2026-10-03T00:00:00.000Z')
  })

  it('rejects timestamps without a zone or invalid values', () => {
    expect(() => parseUtcIso('2026-10-03T00:00:00')).toThrow(RangeError)
    expect(() => parseUtcIso('2026-10-03')).toThrow(RangeError)
    expect(() => parseUtcIso('2026-13-45T00:00:00Z')).toThrow(RangeError)
  })

  it('adds seconds and days', () => {
    const base = parseUtcIso('2026-10-31T23:59:30Z')
    expect(toUtcIso(addSeconds(base, 45))).toBe('2026-11-01T00:00:15.000Z')
    expect(toUtcIso(addDays(base, 1))).toBe('2026-11-01T23:59:30.000Z')
  })

  it('truncates to the start of the UTC day', () => {
    expect(toUtcIso(startOfUtcDay(parseUtcIso('2026-10-03T23:30:00-02:00')))).toBe(
      '2026-10-04T00:00:00.000Z',
    )
  })
})
