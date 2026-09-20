import { describe, expect, test } from 'vitest'
import { rangeMonths, resolveRange, type DateRange } from '../src/dateRanges'

function localDateTime(date: string, hour = 12): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour)
}

describe('resolveRange', () => {
  test('returns the recent seven calendar days, including today', () => {
    expect(resolveRange('recent', undefined, undefined, localDateTime('2026-09-20', 15))).toEqual({
      from: '2026-09-14',
      to: '2026-09-20',
    })
  })

  test.each([
    ['2026-09-20', { from: '2026-09-14', to: '2026-09-20' }],
    ['2026-09-21', { from: '2026-09-21', to: '2026-09-27' }],
    ['2026-09-23', { from: '2026-09-21', to: '2026-09-27' }],
  ])('resolves the week containing %s as Monday through Sunday', (date, expected) => {
    expect(resolveRange('week', undefined, undefined, localDateTime(date))).toEqual(expected)
  })

  test('resolves the previous complete week across a month boundary', () => {
    expect(resolveRange('previous', undefined, undefined, localDateTime('2026-09-02'))).toEqual({
      from: '2026-08-24',
      to: '2026-08-30',
    })
  })

  test('crosses the year boundary without losing a day or a month', () => {
    const range = resolveRange('recent', undefined, undefined, localDateTime('2027-01-03'))
    expect(range).toEqual({ from: '2026-12-28', to: '2027-01-03' })
    expect(rangeMonths(range)).toEqual([
      { month: '2026-12', from: '2026-12-01', to: '2026-12-31' },
      { month: '2027-01', from: '2027-01-01', to: '2027-01-31' },
    ])
  })

  test('accepts strict leap-day custom ranges', () => {
    expect(resolveRange('custom', '2024-02-29', '2024-03-01')).toEqual({
      from: '2024-02-29',
      to: '2024-03-01',
    })
  })

  test.each([
    [undefined, '2026-09-20'],
    ['2026-09-20', undefined],
    ['', '2026-09-20'],
    ['2026-9-20', '2026-09-20'],
    ['2026-02-29', '2026-03-01'],
    ['2026-09-20', '2026-09-19'],
  ])('rejects invalid custom range %s to %s', (from, to) => {
    expect(() => resolveRange('custom', from, to)).toThrow(/custom|valid|date/i)
  })

  test('uses local calendar arithmetic around a daylight-saving transition', () => {
    expect(resolveRange('recent', undefined, undefined, localDateTime('2024-03-10', 8))).toEqual({
      from: '2024-03-04',
      to: '2024-03-10',
    })
  })
})

describe('rangeMonths', () => {
  test('returns full month boundaries for every intersecting month', () => {
    const range: DateRange = { from: '2024-02-29', to: '2024-04-02' }
    expect(rangeMonths(range)).toEqual([
      { month: '2024-02', from: '2024-02-01', to: '2024-02-29' },
      { month: '2024-03', from: '2024-03-01', to: '2024-03-31' },
      { month: '2024-04', from: '2024-04-01', to: '2024-04-30' },
    ])
  })

  test('handles a single month and rejects reversed ranges', () => {
    expect(rangeMonths({ from: '2026-09-20', to: '2026-09-20' })).toEqual([
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30' },
    ])
    expect(() => rangeMonths({ from: '2026-09-21', to: '2026-09-20' })).toThrow(/range|date/i)
  })
})
