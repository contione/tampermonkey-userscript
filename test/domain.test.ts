import { describe, expect, test } from 'vitest'
import {
  duration,
  parseEstimate,
  parseTime,
  parseWork,
  pauseTracker,
  resolveDate,
  resolveIssue,
  resumeTracker,
  startTracker,
  trackerSeconds,
  trackerWorklogs,
  type Tracker,
} from '../src/domain'

function localDateTime(date: string, hour: number, minute: number, second = 0): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day, hour, minute, second, 0)
}

function localIntervalSeconds(date: string, startTime: string, endTime: string): number {
  const [startHour, startMinute] = startTime.split(':').map(Number)
  const [endHour, endMinute] = endTime.split(':').map(Number)
  const start = localDateTime(date, startHour, startMinute)
  const end = localDateTime(date, endHour, endMinute)
  if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1)
  return (end.getTime() - start.getTime()) / 1000
}

describe('resolveDate', () => {
  const now = localDateTime('2026-09-20', 15, 45, 12)

  test.each([
    ['', '2026-09-20'],
    ['t', '2026-09-20'],
    ['today', '2026-09-20'],
    ['y', '2026-09-19'],
    ['yesterday', '2026-09-19'],
    ['t+2', '2026-09-22'],
    ['today+2', '2026-09-22'],
    ['t-3', '2026-09-17'],
    ['today-3', '2026-09-17'],
    ['2024-02-29', '2024-02-29'],
  ])('%s resolves to %s', (input, expected) => {
    expect(resolveDate(input, now)).toBe(expected)
  })

  test.each(['2026-9-20', '2026-09-2', '2026-02-29', '2026-09-31', '20-09-20', 'tomorrow'])(
    'rejects non-strict date input %s', input => {
      expect(() => resolveDate(input, now)).toThrow(/date/i)
    },
  )
})

describe('parseTime', () => {
  test.each([
    ['9', '09:00:00'],
    ['09', '09:00:00'],
    ['9:05', '09:05:00'],
    ['09:30', '09:30:00'],
    ['9.05', '09:05:00'],
    ['09.30', '09:30:00'],
  ])('%s parses as %s', (input, expected) => {
    expect(parseTime(input)).toBe(expected)
  })

  test.each(['', '24', '9:60', '9.60', 'nine'])('rejects invalid time %s', input => {
    expect(() => parseTime(input)).toThrow(/time/i)
  })
})

describe('parseWork', () => {
  const date = '2026-09-20'
  const now = localDateTime(date, 14, 35, 7)

  test('parses a duration with a supplied start time and mixed-case units', () => {
    expect(parseWork('1H20M', date, '9.30', now)).toEqual({
      timeSpentSeconds: 80 * 60,
      startTime: '09:30:00',
    })
  })

  test('uses the local current time when duration start is omitted', () => {
    expect(parseWork('20m', date, undefined, now)).toEqual({
      timeSpentSeconds: 20 * 60,
      startTime: '14:35:07',
    })
  })

  test('parses an interval and formats its start time', () => {
    expect(parseWork('11-12:30', date, undefined, now)).toEqual({
      timeSpentSeconds: 90 * 60,
      startTime: '11:00:00',
    })
  })

  test('counts a cross-midnight interval using local Date arithmetic', () => {
    expect(parseWork('23:30-00:30', date, undefined, now)).toEqual({
      timeSpentSeconds: localIntervalSeconds(date, '23:30', '00:30'),
      startTime: '23:30:00',
    })
  })

  test('treats an equal interval as a full local day', () => {
    expect(parseWork('12-12', date, undefined, now)).toEqual({
      timeSpentSeconds: localIntervalSeconds(date, '12:00', '12:00'),
      startTime: '12:00:00',
    })
  })

  test('uses local Date arithmetic across a daylight-saving transition when present', () => {
    const dstDate = '2024-03-10'
    const expected = localIntervalSeconds(dstDate, '01:30', '03:30')
    expect(parseWork('01:30-03:30', dstDate, undefined, localDateTime(dstDate, 8, 0))).toEqual({
      timeSpentSeconds: expected,
      startTime: '01:30:00',
    })
  })

  test.each(['', '0m', '0h', 'something', '25x'])('rejects non-positive or invalid work input %s', input => {
    expect(() => parseWork(input, date, undefined, now)).toThrow(/work|duration|interval|time/i)
  })

  test('rejects an invalid duration start time before writing work', () => {
    expect(() => parseWork('1h', date, 'not-a-time', now)).toThrow(/time/i)
  })
})

describe('parseEstimate and duration', () => {
  test.each([
    ['', undefined],
    ['   ', undefined],
    ['0h', 0],
    ['1h30m', 90 * 60],
    ['45M', 45 * 60],
  ])('%s parses as %s', (input, expected) => {
    expect(parseEstimate(input)).toBe(expected)
  })

  test.each(['-1h', '-30m', 'invalid'])('rejects estimate %s', input => {
    expect(() => parseEstimate(input)).toThrow(/estimate|duration|invalid|negative/i)
  })

  test.each([
    [0, '0h'],
    [59, '0h'],
    [60, '1m'],
    [90, '1m'],
    [3600, '1h'],
    [3660, '1h1m'],
    [-60, '-1m'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(duration(seconds)).toBe(expected)
  })
})

describe('tracker state machine', () => {
  const base = localDateTime('2026-09-20', 9, 0).getTime()

  test('starts, pauses, resumes, and preserves completed intervals', () => {
    const started = startTracker('nova-318', 'Morning review', base)
    expect(started).toEqual({
      issueKey: 'NOVA-318',
      description: 'Morning review',
      activeSince: base,
      intervals: [],
    })

    const paused = pauseTracker(started, base + 125 * 1000)
    expect(paused.activeSince).toBeNull()
    expect(paused.intervals).toHaveLength(1)
    expect(paused.intervals[0]).toMatchObject({ start: base, end: base + 125 * 1000 })
    expect(paused.intervals[0].id).toEqual(expect.any(String))

    const resumed = resumeTracker(paused, base + 300 * 1000)
    expect(resumed.activeSince).toBe(base + 300 * 1000)
    expect(resumed.intervals).toEqual(paused.intervals)

    const resumedAgain = resumeTracker(resumed, base + 400 * 1000)
    expect(resumedAgain.activeSince).toBe(base + 300 * 1000)
  })

  test('drops short intervals and does not duplicate a repeated pause', () => {
    const started = startTracker('NOVA-318', '', base)
    const paused = pauseTracker(started, base + 59 * 1000)
    expect(paused.activeSince).toBeNull()
    expect(paused.intervals).toEqual([])
    expect(pauseTracker(paused, base + 120 * 1000)).toEqual(paused)
  })

  test('counts saved intervals and the current active interval', () => {
    const tracker: Tracker = {
      issueKey: 'NOVA-318',
      description: '',
      activeSince: base + 300,
      intervals: [
        { id: 'saved-1', start: base, end: base + 90 * 1000 },
        { id: 'saved-2', start: base + 120 * 1000, end: base + 180 * 1000 },
      ],
    }
    expect(trackerSeconds(tracker, base + 45 * 1000 + 300)).toBe(120)
  })
})

describe('trackerWorklogs', () => {
  const firstStart = localDateTime('2026-09-20', 9, 0, 5).getTime()
  const firstEnd = localDateTime('2026-09-20', 10, 1, 59).getTime()
  const secondStart = localDateTime('2026-09-20', 11, 30).getTime()
  const secondEnd = localDateTime('2026-09-20', 11, 31, 15).getTime()
  const tracker: Tracker = {
    issueKey: 'NOVA-318',
    description: 'Retryable upload',
    activeSince: null,
    intervals: [
      { id: 'first', start: firstStart, end: firstEnd },
      { id: 'second', start: secondStart, end: secondEnd },
    ],
  }

  test('creates one worklog per interval and floors each duration to minutes', () => {
    expect(trackerWorklogs(tracker)).toEqual([
      {
        intervalId: 'first',
        date: '2026-09-20',
        startTime: '09:00:00',
        timeSpentSeconds: 61 * 60,
      },
      {
        intervalId: 'second',
        date: '2026-09-20',
        startTime: '11:30:00',
        timeSpentSeconds: 60,
      },
    ])
  })

  test('generates a retry from intervals that remain after a failed upload', () => {
    const failed = { ...tracker, intervals: tracker.intervals.filter(interval => interval.id === 'second') }
    expect(trackerWorklogs(failed)).toEqual([{
      intervalId: 'second',
      date: '2026-09-20',
      startTime: '11:30:00',
      timeSpentSeconds: 60,
    }])
  })

  test('filters intervals shorter than one minute', () => {
    const short = {
      ...tracker,
      intervals: [{ id: 'short', start: firstStart, end: firstStart + 59 * 1000 }],
    }
    expect(trackerWorklogs(short)).toEqual([])
  })
})

describe('resolveIssue', () => {
  test('uppercases valid issue keys, including underscores', () => {
    expect(resolveIssue('nova_2-318', {})).toBe('NOVA_2-318')
  })

  test('resolves an alias by exact name before validating the issue key', () => {
    expect(resolveIssue('review', { review: 'nova-318' })).toBe('NOVA-318')
    expect(() => resolveIssue('Review', { review: 'nova-318' })).toThrow(/issue key|alias/i)
  })

  test.each(['', 'nova', 'nova-abc', 'nova-1-extra', '-318', '1nova-318'])('rejects invalid issue input %s', input => {
    expect(() => resolveIssue(input, {})).toThrow(/issue key|alias/i)
  })
})
