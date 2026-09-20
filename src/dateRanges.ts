export type RangePreset = 'recent' | 'week' | 'previous' | 'custom'

export type DateRange = {
  from: string
  to: string
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function formatDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseDate(value: string): Date {
  const match = DATE_PATTERN.exec(value)
  if (!match) throw new Error('Use YYYY-MM-DD for custom dates.')
  const date = new Date(0)
  date.setHours(12, 0, 0, 0)
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (formatDate(date) !== value) throw new Error('Enter valid custom dates.')
  return date
}

function localDate(date: Date): Date {
  const result = new Date(0)
  result.setHours(12, 0, 0, 0)
  result.setFullYear(date.getFullYear(), date.getMonth(), date.getDate())
  return result
}

function shiftDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function mondayOfWeek(date: Date): Date {
  const mondayOffset = (date.getDay() + 6) % 7
  return shiftDays(date, -mondayOffset)
}

function customRange(from: string | undefined, to: string | undefined): DateRange {
  if (!from || !to) throw new Error('Choose both custom start and end dates.')
  const start = parseDate(from)
  const end = parseDate(to)
  if (from > to) throw new Error('Custom start date must be on or before the end date.')
  return { from: formatDate(start), to: formatDate(end) }
}

export function resolveRange(
  preset: RangePreset,
  from?: string,
  to?: string,
  now = new Date(),
): DateRange {
  if (preset === 'custom') return customRange(from, to)

  const today = localDate(now)
  if (preset === 'recent') {
    return { from: formatDate(shiftDays(today, -6)), to: formatDate(today) }
  }

  if (preset === 'week' || preset === 'previous') {
    const currentMonday = mondayOfWeek(today)
    const start = preset === 'previous' ? shiftDays(currentMonday, -7) : currentMonday
    return { from: formatDate(start), to: formatDate(shiftDays(start, 6)) }
  }

  throw new Error(`Unknown range preset: ${preset}`)
}

export function rangeMonths(range: DateRange): { month: string; from: string; to: string }[] {
  const start = parseDate(range.from)
  const end = parseDate(range.to)
  if (range.from > range.to) throw new Error('Range start date must be on or before the end date.')

  const cursor = new Date(start)
  cursor.setDate(1)
  const months: { month: string; from: string; to: string }[] = []
  while (cursor.getTime() <= end.getTime()) {
    const monthStart = new Date(cursor)
    const monthEnd = new Date(cursor)
    monthEnd.setMonth(monthEnd.getMonth() + 1)
    monthEnd.setDate(0)
    months.push({
      month: `${String(cursor.getFullYear()).padStart(4, '0')}-${String(cursor.getMonth() + 1).padStart(2, '0')}`,
      from: formatDate(monthStart),
      to: formatDate(monthEnd),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
}
