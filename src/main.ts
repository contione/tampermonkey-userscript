import { createApi, discoverAccount, type Credentials, type DaySchedule, type Worklog } from './api'
import { duration, parseEstimate, parseWork, pauseTracker, resolveDate, resolveIssue, resumeTracker, startTracker, trackerSeconds, trackerWorklogs, type Tracker } from './domain'
import { readState, subscribe, transaction, type State } from './store'
import { styles } from './styles'

declare function GM_registerMenuCommand(label: string, callback: () => void): void

if (!document.getElementById('tempo-userscript')) mount()

function mount(): void {
  const host = document.createElement('div')
  host.id = 'tempo-userscript'
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${styles}\n.launcher,.panel{pointer-events:auto}</style>
    <button class="launcher" aria-label="Open Tempo">Tempo</button>
    <section class="panel" hidden aria-label="Tempo panel">
      <header><div><h1>Tempo</h1><span class="muted">Work without the tab switching</span></div><button class="close" aria-label="Close Tempo">×</button></header>
      <nav role="tablist" aria-label="Tempo navigation">${['Worklogs','Trackers','Aliases','Settings'].map(t => `<button role="tab" data-tab="${t}">${t}</button>`).join('')}</nav>
      <div class="status" role="status" aria-live="polite"></div><main></main>
    </section>`
  document.body.append(host)
  const panel = root.querySelector<HTMLElement>('.panel')!
  const main = root.querySelector<HTMLElement>('main')!
  const status = root.querySelector<HTMLElement>('.status')!
  const launcher = root.querySelector<HTMLButtonElement>('.launcher')!
  let tab = readState().credentials ? 'Worklogs' : 'Settings'
  let busy = false
  let loaded = false
  let selectedDate = resolveDate('')
  let logs: Worklog[] = []
  let schedule: DaySchedule[] = []
  const issueKeys = new Map<string, string>()
  const selected = new Set<string>()
  const drafts: Record<string, string> = { date: selectedDate }
  let verbose = false

  function notice(message: string, error = false): void {
    status.textContent = message
    status.classList.toggle('error', error)
  }
  function open(): void {
    panel.hidden = false
    launcher.hidden = true
    if (!drafts.issue) drafts.issue = currentIssue()
    render()
    root.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.focus()
    if (tab === 'Worklogs' && !loaded) void run(refresh)
  }
  function close(): void { panel.hidden = true; launcher.hidden = false; launcher.focus() }
  launcher.onclick = open
  root.querySelector<HTMLButtonElement>('.close')!.onclick = close
  GM_registerMenuCommand('Open Tempo', open)
  root.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Escape') close() })
  root.querySelector('nav')!.addEventListener('click', e => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tab]')
    if (!button || busy) return
    tab = button.dataset.tab!
    notice('')
    render()
    if (tab === 'Worklogs' && !loaded && readState().credentials) void run(refresh)
  })
  main.addEventListener('input', e => {
    const input = e.target as HTMLInputElement
    if (input.name && input.type !== 'checkbox') drafts[input.name] = input.value
  })
  main.addEventListener('change', e => {
    const input = e.target as HTMLInputElement
    if (input.dataset.select) {
      if (input.checked) selected.add(input.dataset.select)
      else selected.delete(input.dataset.select)
    }
    if (input.name === 'verbose') { verbose = input.checked; render() }
  })
  main.addEventListener('submit', e => {
    e.preventDefault()
    const name = (e.target as HTMLFormElement).dataset.form
    if (name) void run(() => submit(name))
  })
  main.addEventListener('click', e => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
    if (button) void run(() => action(button.dataset.action!, button.dataset.id))
  })
  subscribe(() => { if (!busy && !panel.hidden && (tab === 'Trackers' || tab === 'Aliases')) render() })
  setInterval(() => {
    if (panel.hidden || tab !== 'Trackers') return
    const state = readState()
    for (const node of root.querySelectorAll<HTMLElement>('[data-duration]')) {
      const tracker = state.trackers[node.dataset.duration!]
      if (tracker) node.textContent = duration(trackerSeconds(tracker, Date.now()))
    }
  }, 1000)

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    notice('Working…')
    root.querySelectorAll<HTMLButtonElement>('main button, nav button').forEach(b => { b.disabled = true })
    main.setAttribute('aria-busy', 'true')
    try { await task() } catch (error) { notice(error instanceof Error ? error.message : 'Something went wrong.', true) }
    finally { busy = false; render(); main.removeAttribute('aria-busy') }
  }
  function credentials(state = readState()): Credentials {
    if (!state.credentials) throw new Error('Open Settings and connect your Jira and Tempo accounts first.')
    if (state.credentials.hostname !== location.hostname) throw new Error('Credentials belong to a different Jira site. Connect this site in Settings.')
    return state.credentials
  }
  async function refresh(): Promise<void> {
    const api = createApi(credentials())
    const date = resolveDate(drafts.date || '')
    const [year, month] = date.split('-').map(Number)
    const from = `${date.slice(0,7)}-01`
    const to = `${date.slice(0,7)}-${new Date(year, month, 0).getDate()}`
    const [items, days] = await Promise.all([api.getWorklogs(from, to), api.getSchedule(from, to)])
    const needed = [...new Set(items.filter(w => w.startDate === date).map(w => w.issueId))].filter(id => !issueKeys.has(id))
    let cursor = 0
    const workers = Array.from({length: Math.min(4, needed.length)}, async () => {
      while (cursor < needed.length) {
        const id = needed[cursor++]
        try { issueKeys.set(id, await api.getIssueKey(id)) } catch { /* Keep the ID visible if the issue is inaccessible. */ }
      }
    })
    await Promise.all(workers)
    logs = items; schedule = days; selectedDate = date; drafts.date = date; loaded = true; selected.clear()
    notice('Worklogs refreshed.')
  }
  async function submit(name: string): Promise<void> {
    if (name === 'settings') {
      await transaction(async (state, save) => {
        const input = { hostname: location.hostname, email: drafts.email?.trim() || state.credentials?.email || '',
          jiraToken: drafts.jiraToken?.trim() || state.credentials?.jiraToken || '' }
        const tempoToken = drafts.tempoToken?.trim() || state.credentials?.tempoToken || ''
        if (!tempoToken) throw new Error('Enter a Tempo API token.')
        const identity = await discoverAccount(input)
        const next = { ...input, tempoToken, accountId: identity.accountId }
        const today = resolveDate('')
        await createApi(next).getSchedule(today, today)
        if (Object.keys(state.trackers).length && state.credentials?.accountId !== next.accountId) throw new Error('Finish or delete your local trackers before switching accounts.')
        state.credentials = next; await save()
        drafts.jiraToken = ''; drafts.tempoToken = ''; loaded = false; logs = []; schedule = []; issueKeys.clear()
        notice(`Connected as ${identity.displayName || identity.accountId}.`)
      })
    } else if (name === 'worklog') {
      await transaction(async (state) => {
        const issue = resolveIssue(drafts.issue || '', state.aliases)
        const date = resolveDate(drafts.date || '')
        const parsed = parseWork(drafts.work || '', date, drafts.start)
        const remainingEstimateSeconds = parseEstimate(drafts.estimate || '')
        const api = createApi(credentials(state))
        const issueId = await api.getIssueId(issue)
        const result = await api.addWorklog({ issueId, ...parsed, startDate: date, description: drafts.description || '', remainingEstimateSeconds })
        drafts.work = ''; drafts.description = ''; loaded = false
        notice(`Saved ${duration(parsed.timeSpentSeconds)} to ${issue}. Worklog #${result.id}.`)
      })
      const message = status.textContent!
      try { await refresh(); notice(message) } catch { notice(`${message} Refresh failed; try Refresh before submitting again.`) }
    } else if (name === 'alias') {
      await transaction(async (state, save) => {
        const alias = (drafts.alias || '').trim()
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(alias) || ['__proto__','constructor','prototype'].includes(alias)) throw new Error('Use 1–40 letters, numbers, dashes or underscores for the alias.')
        state.aliases[alias] = resolveIssue(drafts.aliasIssue || '', {})
        await save(); notice(`Saved alias ${alias}.`)
      })
    } else if (name === 'tracker') {
      const stopPrevious = main.querySelector<HTMLInputElement>('[name="stopPrevious"]')?.checked
      await transaction(async (state, save) => {
        const issue = resolveIssue(drafts.trackerIssue || currentIssue(), state.aliases)
        if (state.trackers[issue]) {
          if (!stopPrevious) throw new Error('A tracker already exists for this issue. Resume it, or select Stop previous.')
          await uploadTracker(state, save, issue)
        }
        state.trackers[issue] = startTracker(issue, drafts.trackerDescription || '', Date.now()); await save(); notice(`Started ${issue}.`)
      })
    }
  }
  async function uploadTracker(state: State, save: () => Promise<void>, key: string): Promise<void> {
    const existing = state.trackers[key]
    if (!existing) throw new Error('This tracker no longer exists. Refresh the panel.')
    const estimate = parseEstimate(drafts.trackerEstimate || '')
    const tracker = pauseTracker(existing, Date.now())
    state.trackers[key] = tracker; await save()
    const intervals = trackerWorklogs(tracker)
    if (!intervals.length) { delete state.trackers[key]; await save(); notice(`Removed ${key}: no intervals of at least one minute.`); return }
    const api = createApi(credentials(state))
    const issueId = await api.getIssueId(key)
    let failed = 0
    for (const interval of intervals) {
      try {
        await api.addWorklog({ issueId, startDate: interval.date, startTime: interval.startTime, timeSpentSeconds: interval.timeSpentSeconds,
          description: drafts.stopDescription || tracker.description, remainingEstimateSeconds: estimate })
      } catch { failed++; continue }
      tracker.intervals = tracker.intervals.filter(i => i.id !== interval.intervalId)
      await save() // Stop on storage failure before uploading another interval.
    }
    loaded = false
    if (failed) throw new Error(`${failed} interval(s) failed and remain paused. Check Tempo before retrying if a request timed out.`)
    delete state.trackers[key]; await save(); notice(`Logged all intervals for ${key}.`)
  }
  async function action(name: string, id?: string): Promise<void> {
    if (name === 'refresh') return refresh()
    if (name === 'current') { drafts.issue = currentIssue(); notice(drafts.issue ? 'Current issue selected.' : 'Open a Jira issue to use this shortcut.'); return }
    if (name === 'delete' || name === 'delete-selected') {
      const ids = id ? [id] : [...selected]
      if (!ids.length) { notice('Select worklogs to delete.'); return }
      if (!window.confirm(`Delete ${ids.length} Tempo worklog(s)? This cannot be undone.`)) { notice('Deletion cancelled.'); return }
      await transaction(async state => {
        const api = createApi(credentials(state)); const failed: string[] = []
        for (const value of ids) {
          try { await api.deleteWorklog(value); logs = logs.filter(w => w.id !== value); selected.delete(value) } catch { failed.push(value) }
        }
        notice(failed.length ? `Could not delete: ${failed.join(', ')}. Other selected worklogs were deleted.` : `Deleted ${ids.length} worklog(s).`, !!failed.length)
      })
      return
    }
    if (name === 'disconnect') {
      if (!window.confirm('Remove saved credentials for this Jira site? Aliases and trackers will be kept.')) { notice('Cancelled.'); return }
      await transaction(async (state, save) => { delete state.credentials; await save() })
      drafts.email = ''; drafts.jiraToken = ''; drafts.tempoToken = ''; loaded = false; logs = []; schedule = []; issueKeys.clear(); notice('Credentials removed.'); return
    }
    await transaction(async (state, save) => {
      if (!id) return
      if (name === 'alias-delete') { delete state.aliases[id]; await save(); notice(`Deleted alias ${id}.`); return }
      const tracker = state.trackers[id]
      if (!tracker) throw new Error('This tracker no longer exists.')
      if (name === 'pause') state.trackers[id] = pauseTracker(tracker, Date.now())
      else if (name === 'resume') state.trackers[id] = resumeTracker(tracker, Date.now())
      else if (name === 'stop') { await uploadTracker(state, save, id); return }
      else if (name === 'tracker-delete') {
        if (!window.confirm(`Discard local tracker ${id} without uploading?`)) { notice('Cancelled.'); return }
        delete state.trackers[id]
      }
      await save(); notice('Tracker updated.')
    })
  }

  function field(name: string, label: string, placeholder = '', type = 'text', fallback = ''): string {
    return `<label>${label}<input name="${name}" type="${type}" value="${escape(drafts[name] ?? fallback)}" placeholder="${escape(placeholder)}" autocomplete="off" ${type === 'password' ? 'data-lpignore="true"' : ''}></label>`
  }
  function button(action: string, text: string, id?: string, style = ''): string {
    return `<button type="button" class="${style}" data-action="${action}" ${id ? `data-id="${escape(id)}"` : ''}>${text}</button>`
  }
  function render(): void {
    const state = readState()
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.tab === tab)); b.disabled = busy })
    if (tab === 'Settings') {
      main.innerHTML = `<h2 style="margin-top:0">Connect your accounts</h2><p class="muted">${escape(location.hostname)}</p>
      <form data-form="settings">${field('email','Jira email','you@example.com','email',state.credentials?.email || '')}
      ${field('jiraToken','Jira API token',state.credentials ? 'Leave blank to keep saved token' : 'API token without scopes','password')}
      ${field('tempoToken','Tempo API token',state.credentials ? 'Leave blank to keep saved token' : 'Tempo Settings → API integration','password')}
      <p class="muted">Your account ID is discovered automatically. Tokens stay in Tampermonkey storage on this browser.</p>
      <button class="primary wide" type="submit">${state.credentials ? 'Verify & save' : 'Connect accounts'}</button></form>
      ${state.credentials ? `<p style="margin-top:14px"><small>Connected account: ${escape(state.credentials.accountId)}</small></p>${button('disconnect','Remove credentials',undefined,'danger')}` : ''}
      <hr><p style="margin-top:16px"><a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer">Create a Jira token</a></p>
      <small>Use an Atlassian API token without scopes. Scoped tokens require a different Jira gateway and are not supported by this version.</small>`
    } else if (tab === 'Aliases') {
      main.innerHTML = `<h2 style="margin-top:0">Issue shortcuts</h2><p class="muted">Use aliases in worklogs and trackers.</p>
      ${Object.entries(state.aliases).length ? `<table><thead><tr><th>Alias</th><th>Issue</th><th></th></tr></thead><tbody>${Object.entries(state.aliases).map(([name,key]) => `<tr><td>${escape(name)}</td><td>${escape(key)}</td><td>${button('alias-delete','Delete',name,'small danger')}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No aliases yet.</p>'}
      <hr><h2>Add an alias</h2><form data-form="alias">${field('alias','Alias','review')}${field('aliasIssue','Issue key','NOVA-318')}<button type="submit" class="primary wide">Save alias</button></form>`
    } else if (tab === 'Trackers') {
      main.innerHTML = `<p class="muted">Track locally. Stop to submit each work interval to Tempo.</p>
      ${Object.values(state.trackers).length ? Object.values(state.trackers).map(tracker => renderTracker(tracker)).join('') : '<p class="empty">No trackers yet.</p>'}
      <h2>Stop options</h2>${field('stopDescription','Override description (optional)')}${field('trackerEstimate','Remaining estimate (optional)','2h')}
      <hr><h2>Start a tracker</h2><form data-form="tracker">${field('trackerIssue','Issue or alias','NOVA-318','text',currentIssue())}${field('trackerDescription','Description')}
      <label class="check"><input type="checkbox" name="stopPrevious">Stop and log the previous tracker for this issue</label><button type="submit" class="primary wide">Start tracker</button></form>`
    } else {
      const dayLogs = logs.filter(w => w.startDate === selectedDate).sort((a,b) => a.startTime.localeCompare(b.startTime))
      const sum = (items: Worklog[]) => items.reduce((n,w) => n + w.timeSpentSeconds, 0)
      const required = schedule.reduce((n,d) => n + d.requiredSeconds, 0)
      const today = resolveDate('')
      const delta = sum(logs) - schedule.filter(d => d.date <= today).reduce((n,d) => n+d.requiredSeconds,0)
      main.innerHTML = `<div class="row"><input aria-label="Worklog date" name="date" value="${escape(drafts.date)}" placeholder="YYYY-MM-DD or yesterday">${button('refresh','Refresh')}</div>
      ${loaded ? `<div class="summary">Month ${selectedDate.slice(0,7)}: <strong>${duration(sum(logs))} / ${duration(required)}</strong> <span class="muted">(${delta >= 0 ? '+' : ''}${duration(delta)})</span><br>Selected day: <strong>${duration(sum(dayLogs))} / ${duration(schedule.find(d => d.date === selectedDate)?.requiredSeconds || 0)}</strong></div>` : '<p class="empty">Connect in Settings, then refresh your worklogs.</p>'}
      <label class="check"><input type="checkbox" name="verbose" ${verbose ? 'checked' : ''}>Show descriptions & worklog IDs</label>
      <div class="table-wrap"><table><thead><tr><th></th><th>Time</th><th>Issue</th><th>Duration</th><th></th></tr></thead><tbody>
      ${dayLogs.map(w => `<tr><td><input type="checkbox" aria-label="Select worklog ${escape(w.id)}" data-select="${escape(w.id)}" ${selected.has(w.id) ? 'checked' : ''}></td><td class="nowrap">${escape(w.startTime.slice(0,5))}–${endTime(w)}</td><td><a target="_blank" rel="noopener noreferrer" href="https://${location.hostname}/browse/${encodeURIComponent(issueKeys.get(w.issueId) || w.issueId)}">${escape(issueKeys.get(w.issueId) || `#${w.issueId}`)}</a>${aliasLabels(state,w)}${verbose ? `<p>${escape(w.description)}</p><small>#${escape(w.id)}</small>` : ''}</td><td>${duration(w.timeSpentSeconds)}</td><td>${button('delete','Delete',w.id,'small danger')}</td></tr>`).join('')}
      </tbody></table></div>${loaded && !dayLogs.length ? '<p class="empty">No worklogs for this day.</p>' : ''}
      ${dayLogs.length ? `<div class="actions">${button('delete-selected','Delete selected',undefined,'small danger')}</div>` : ''}
      <hr><h2>Log work</h2><form data-form="worklog"><div class="row">${field('issue','Issue or alias','NOVA-318','text',currentIssue())}
      ${button('current','Use current issue',undefined,'small')}</div><div class="grid">${field('work','Duration or interval','1h20m or 09:40-11:00')}${field('start','Start time (optional)','09:40')}</div>
      <label>Description<textarea name="description">${escape(drafts.description || '')}</textarea></label>${field('estimate','Remaining estimate (optional)','2h')}
      <button class="primary wide" type="submit">Save worklog</button></form>`
    }
  }
  function aliasLabels(state: State,w: Worklog): string {
    const names = Object.entries(state.aliases).filter(([,key]) => key === issueKeys.get(w.issueId)).map(([name]) => name)
    return names.length ? `<p class="muted">${escape(names.join(', '))}</p>` : ''
  }
  function renderTracker(tracker: Tracker): string {
    const key = tracker.issueKey
    return `<article class="tracker"><div class="tracker-title"><strong>${escape(key)}</strong><span data-duration="${escape(key)}">${duration(trackerSeconds(tracker,Date.now()))}</span></div>
    <small>${tracker.activeSince === null ? 'Paused' : 'Running'}</small><p>${escape(tracker.description)}</p>
    <div class="actions">${button(tracker.activeSince === null ? 'resume' : 'pause', tracker.activeSince === null ? 'Resume' : 'Pause', key)}${button('stop','Stop & log',key,'primary')}${button('tracker-delete','Discard',key,'danger')}</div>
    <details><summary>${tracker.intervals.length} saved interval(s)</summary>${tracker.intervals.map(i => `<p><small>${escape(new Date(i.start).toLocaleString())} → ${escape(new Date(i.end).toLocaleString())} · ${duration(Math.floor((i.end-i.start)/60000)*60)}</small></p>`).join('')}</details></article>`
  }
}

function escape(value: string): string { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)) }
function currentIssue(): string {
  const url = new URL(location.href)
  const candidate = url.searchParams.get('selectedIssue') || url.pathname.match(/\/browse\/([A-Za-z][\w]*-\d+)/)?.[1] || ''
  return /^[a-zA-Z][\w]*-\d+$/.test(candidate) ? candidate.toUpperCase() : ''
}
function endTime(worklog: Worklog): string {
  const date = new Date(`${worklog.startDate}T${worklog.startTime || '00:00:00'}`)
  date.setTime(date.getTime()+worklog.timeSpentSeconds*1000)
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
}
