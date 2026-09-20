// Browser-only fake GM bridge. No credentials or requests leave this fixture.
(() => {
  const fixed = '2026-09-19'
  const initial = {
    version: 1,
    credentials: { hostname: 'demo.atlassian.net', email: 'demo@example.com', jiraToken: 'demo-jira-token', tempoToken: 'demo-tempo-token', accountId: 'demo-account' },
    aliases: { review: 'NOVA-318' }, trackers: {}
  }
  const stateKey = 'fixture-state'
  const shouldSeed = !new URL(location.href).searchParams.has('setup')
  window.GM_getValue = (_key, fallback) => JSON.parse(localStorage.getItem(stateKey) || JSON.stringify(shouldSeed ? initial : fallback))
  window.GM_setValue = (_key, value) => localStorage.setItem(stateKey, JSON.stringify(value))
  window.GM = { getValue: async (key, fallback) => window.GM_getValue(key, fallback), setValue: async (key, value) => window.GM_setValue(key, value) }
  window.GM_addValueChangeListener = (_key, listener) => { window.addEventListener('storage', listener); return 1 }
  window.GM_registerMenuCommand = () => {}
  const log = (id, issue, start, seconds, description) => ({ tempoWorklogId: id, issue: { id: issue }, author: { accountId: 'demo-account' }, startDate: fixed, startTime: start, timeSpentSeconds: seconds, description })
  window.__logs = [log(931842, 10001, '09:40:00', 4800, 'Investigated webhook retries'), log(931859, 10002, '13:00:00', 2700, 'Release checklist')]
  window.__requests = []
  window.__attributes = []
  window.GM_xmlhttpRequest = options => {
    window.__requests.push({ method: options.method, url: options.url, data: options.data })
    const url = new URL(options.url)
    let status = 200, data
    if (url.pathname.endsWith('/myself')) data = { accountId: 'demo-account', active: true, displayName: 'Alex Morgan' }
    else if (url.pathname.includes('/rest/api/3/issue/')) {
      const issue = decodeURIComponent(url.pathname.split('/').pop())
      data = { id: issue === 'OPS-42' || issue === '10002' ? '10002' : '10001', key: issue === 'OPS-42' || issue === '10002' ? 'OPS-42' : 'NOVA-318' }
    } else if (url.pathname.includes('/user-schedule')) data = { results: [{ date: fixed, requiredSeconds: 28800, type: 'WORKING_DAY' }] }
    else if (url.pathname === '/4/work-attributes') {
      if (window.__failAttributes) { status = 403; data = { errors: { message: 'Attributes access denied' } } }
      else data = { results: window.__attributes, metadata: {} }
    }
    else if (options.method === 'POST') {
      const body = JSON.parse(options.data)
      if (window.__failPosts) { status = 400; data = { errors: { message: 'Simulated failure' } } }
      else if (window.__attributes.some(attribute => attribute.required && !body.attributes?.some(value => value.key === attribute.key && value.value))) { status = 400; data = { errors: { message: 'Work attribute Task (Task) is required' } } }
      else { data = { ...body, tempoWorklogId: 940000 + window.__logs.length, issue: { id: body.issueId }, author: { accountId: body.authorAccountId } }; window.__logs.push(data) }
    } else if (options.method === 'DELETE') {
      const id = url.pathname.split('/').pop()
      if (window.__deleteFailId === id) { status = 403; data = { errors: { message: 'Permission denied' } } }
      else { window.__logs = window.__logs.filter(w => String(w.tempoWorklogId) !== id); status = 204 }
    } else if (url.pathname.includes('/worklogs/user/')) data = { results: window.__logs, metadata: {} }
    else { status = 404; data = { errors: { message: 'Fixture route not found' } } }
    const handle = setTimeout(() => options.onload({ status, responseText: data ? JSON.stringify(data) : '', responseHeaders: 'Content-Type: application/json', finalUrl: url.href }), 10)
    return { abort() { clearTimeout(handle); options.onabort?.({}) } }
  }
})()
