export type Tracker = {
  issueKey: string
  description: string
  activeSince: number | null
  intervals: { id: string; start: number; end: number }[]
}

function day(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
export function resolveDate(input: string, now = new Date()): string {
  const value = input.trim().toLowerCase()
  if (!value || value === 'today' || value === 't') return day(now)
  if (value === 'y' || value === 'yesterday') return shifted(now,-1)
  const relative = /^(?:today|t)([+-]\d+)$/.exec(value)
  if (relative) return shifted(now,Number(relative[1]))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use YYYY-MM-DD, yesterday or today±N for the date.')
  const date = new Date(`${value}T00:00:00`)
  if (!Number.isFinite(date.getTime()) || day(date) !== value) throw new Error('Enter a valid calendar date.')
  return value
}
function shifted(now: Date, days: number): string {
  const date = new Date(now); date.setHours(0,0,0,0); date.setDate(date.getDate()+days)
  if (!Number.isFinite(date.getTime()) || date.getFullYear()<1000 || date.getFullYear()>9999) throw new Error('Date is outside the supported range.')
  return day(date)
}
export function parseTime(input: string): string {
  const result = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(input.trim())
  if (!result || Number(result[1])>23 || Number(result[2] || 0)>59) throw new Error('Use a valid time such as 9, 09:40 or 9.40.')
  return `${result[1].padStart(2,'0')}:${result[2] || '00'}:00`
}
function durationSeconds(input: string): number {
  const parsed = /^(?:(\d+)h)?(?:(\d+)m)?$/i.exec(input.trim())
  if (!parsed || (!parsed[1] && !parsed[2])) throw new Error('Use a duration such as 45m or 1h20m.')
  const seconds = Number(parsed[1] || 0)*3600 + Number(parsed[2] || 0)*60
  if (!Number.isSafeInteger(seconds)) throw new Error('Duration is too large.')
  return seconds
}
export function parseWork(input: string, date: string, start?: string, now = new Date()): { timeSpentSeconds: number; startTime: string } {
  const calendar = resolveDate(date, now)
  if (input.includes('-')) {
    const times = input.split('-')
    if (times.length !== 2) throw new Error('Use an interval such as 09:40-11:00.')
    const startTime = parseTime(times[0]), endTime = parseTime(times[1])
    const from = new Date(`${calendar}T${startTime}`), to = new Date(`${calendar}T${endTime}`)
    if (endTime <= startTime) to.setDate(to.getDate()+1)
    const timeSpentSeconds = (to.getTime()-from.getTime())/1000
    if (timeSpentSeconds<=0) throw new Error('Interval has no elapsed time in this timezone.')
    return { startTime, timeSpentSeconds }
  }
  const seconds = durationSeconds(input)
  if (seconds<=0) throw new Error('Worked time must be greater than zero.')
  const defaultStart = calendar === day(now) ? `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}` : '00:00'
  const startTime = !start?.trim() && calendar === day(now)
    ? `${defaultStart}:${String(now.getSeconds()).padStart(2,'0')}`
    : parseTime(start?.trim() || defaultStart)
  return { timeSpentSeconds: seconds, startTime }
}
export function parseEstimate(input: string): number | undefined { return input.trim() ? durationSeconds(input) : undefined }
export function duration(seconds: number): string {
  const minutes = Math.floor(Math.abs(seconds)/60), hours = Math.floor(minutes/60)
  return `${seconds<0 && minutes>0 ? '-' : ''}${hours ? `${hours}h` : ''}${minutes%60 ? `${minutes%60}m` : hours ? '' : '0h'}`
}
export function resolveIssue(input: string, aliases: Record<string,string>): string {
  const value = input.trim()
  const key = (Object.hasOwn(aliases,value) ? aliases[value] : value).toUpperCase()
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error('Enter an issue key such as NOVA-318 or a saved alias.')
  return key
}
export function startTracker(issueKey: string, description: string, now: number): Tracker {
  return { issueKey: resolveIssue(issueKey,{}), description, activeSince: now, intervals: [] }
}
export function pauseTracker(tracker: Tracker, now: number): Tracker {
  const next = structuredClone(tracker)
  if (next.activeSince !== null) {
    if (now<next.activeSince) throw new Error('The clock moved backwards. Resume after correcting the clock.')
    if (now-next.activeSince>=60000) next.intervals.push({id:crypto.randomUUID(),start:next.activeSince,end:now})
    next.activeSince = null
  }
  return next
}
export function resumeTracker(tracker: Tracker, now: number): Tracker { return { ...structuredClone(tracker), activeSince: tracker.activeSince ?? now } }
export function trackerSeconds(tracker: Tracker, now: number): number {
  return tracker.intervals.reduce((sum,i)=>sum+Math.floor((i.end-i.start)/60000)*60,0) + (tracker.activeSince === null ? 0 : Math.max(0,Math.floor((now-tracker.activeSince)/60000)*60))
}
export function trackerWorklogs(tracker: Tracker): { intervalId: string; date: string; startTime: string; timeSpentSeconds: number }[] {
  return tracker.intervals.filter(i=>i.end-i.start>=60000).map(i=>{
    const date=new Date(i.start)
    return {intervalId:i.id,date:day(date),startTime:`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:00`,timeSpentSeconds:Math.floor((i.end-i.start)/60000)*60}
  })
}
