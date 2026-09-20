import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
const script = readFileSync('dist/tempo.user.js','utf8')
const html = readFileSync('e2e/jira.html','utf8')
async function launch(page: Page, setup = false) {
  await page.clock.setFixedTime(new Date('2026-09-20T10:00:00+02:00'))
  await page.route('https://demo.atlassian.net/**', route => route.fulfill({ contentType:'text/html', body: html }))
  await page.addInitScript({ path:'e2e/fixture.js' })
  await page.goto(`https://demo.atlassian.net/browse/NOVA-318${setup ? '?setup' : ''}`)
  await page.addScriptTag({ content:script })
  await page.getByRole('button',{name:'Open Tempo'}).click()
  if (!setup) {
    await expect(page.getByRole('status')).toContainText('Worklogs refreshed')
    await expect(page.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled()
    await expect(page.getByRole('link',{name:'NOVA-318',exact:true})).toBeVisible()
  }
}
test('connect discovers account ID, retains tokens privately and can disconnect', async ({page}) => {
  await launch(page,true)
  await page.getByLabel('Jira email',{exact:true}).fill('demo@example.com')
  await page.getByLabel('Jira API token',{exact:true}).fill('demo-jira-token')
  await page.getByLabel('Tempo API token',{exact:true}).fill('demo-tempo-token')
  await page.getByRole('button',{name:'Connect accounts'}).click()
  await expect(page.getByRole('status')).toContainText('Connected as Alex Morgan')
  await expect(page.getByLabel('Jira API token',{exact:true})).toHaveValue('')
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-state')!).credentials.accountId)).toBe('demo-account')
  page.once('dialog',d => d.accept())
  await page.getByRole('button',{name:'Remove credentials'}).click()
  await expect(page.getByRole('status')).toContainText('Credentials removed')
})
test('creates interval worklog, shows details and deletes selection',async ({page}) => {
  const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message))
  await launch(page)
  if (process.env.TEMPO_QA_DIR) await page.screenshot({path:`${process.env.TEMPO_QA_DIR}/desktop.png`})
  await page.getByLabel('Issue or alias',{exact:true}).fill('review')
  await page.getByLabel('Duration or interval',{exact:true}).fill('14:00-14:35')
  await page.getByLabel('Description',{exact:true}).fill('<script>alert(1)</script>')
  await page.getByLabel('Remaining estimate (optional)',{exact:true}).fill('0h')
  await page.getByRole('button',{name:'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('Saved 35m to NOVA-318')
  await page.getByLabel('Show descriptions & worklog IDs').check()
  await expect(page.getByText('<script>alert(1)</script>',{exact:true})).toBeVisible()
  await page.getByLabel('Select worklog 931842').check()
  page.once('dialog',d=>d.accept())
  await page.getByRole('button',{name:'Delete selected'}).click()
  await expect(page.getByRole('status')).toContainText('Deleted 1 worklog')
  await expect(page.getByLabel('Select worklog 931842')).toHaveCount(0)
  expect(errors).toEqual([])
})
test('aliases survive reload and map to canonical issue keys',async ({page}) => {
  await launch(page)
  await page.getByRole('tab',{name:'Aliases',exact:true}).click()
  await page.getByLabel('Alias',{exact:true}).fill('triage')
  await page.getByLabel('Issue key',{exact:true}).fill('ops-42')
  await page.getByRole('button',{name:'Save alias'}).click()
  await expect(page.getByRole('cell',{name:'triage',exact:true})).toBeVisible()
  await page.reload(); await page.addScriptTag({content:script})
  await page.getByRole('button',{name:'Open Tempo'}).click()
  await expect(page.getByRole('status')).toContainText('Worklogs refreshed')
  await page.getByRole('tab',{name:'Aliases',exact:true}).click()
  await expect(page.getByRole('cell',{name:'OPS-42',exact:true})).toBeVisible()
})
test('tracker pauses, resumes, keeps failed intervals and retries only retained work',async ({page}) => {
  await launch(page)
  await page.getByRole('tab',{name:'Trackers',exact:true}).click()
  await page.getByLabel('Issue or alias',{exact:true}).fill('NOVA-318')
  await page.getByRole('button',{name:'Start tracker'}).click()
  await expect(page.getByText('Running',{exact:true})).toBeVisible()
  await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('fixture-state')!);s.trackers['NOVA-318'].activeSince-=120000;localStorage.setItem('fixture-state',JSON.stringify(s))})
  await page.getByRole('button',{name:'Pause',exact:true}).click()
  await expect(page.getByText('Paused',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Resume',exact:true}).click()
  await expect(page.getByText('Running',{exact:true})).toBeVisible()
  await page.evaluate(()=>{(window as any).__failPosts=true})
  await page.getByRole('button',{name:'Stop & log'}).click()
  await expect(page.getByRole('status')).toContainText('failed and remain paused')
  await expect(page.getByRole('button',{name:'Stop & log'})).toBeVisible()
  await page.evaluate(()=>{(window as any).__failPosts=false})
  await page.getByRole('button',{name:'Stop & log'}).click()
  await expect(page.getByRole('status')).toContainText('Logged all intervals')
  await expect(page.getByText('No trackers yet.')).toBeVisible()
})
test('invalid input never creates a worklog and mobile panel fits',async ({page}) => {
  await page.setViewportSize({width:390,height:844})
  await launch(page)
  await page.getByLabel('Duration or interval',{exact:true}).fill('0h')
  if (process.env.TEMPO_QA_DIR) await page.screenshot({path:`${process.env.TEMPO_QA_DIR}/mobile.png`})
  await page.getByRole('button',{name:'Save worklog'}).click()
  await expect(page.locator('.status.error')).toBeVisible()
  const count = await page.evaluate(()=>(window as any).__requests.filter((r:any)=>r.method==='POST').length)
  expect(count).toBe(0)
  const box = await page.getByRole('region',{name:'Tempo panel'}).boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  await page.getByRole('button',{name:'Close Tempo'}).click()
  await expect(page.getByRole('button',{name:'Open Tempo'})).toBeVisible()
})

test('two tabs cannot upload the same tracker interval twice',async ({page,context}) => {
  await launch(page)
  await page.evaluate(()=>{
    const state=(window as any).GM_getValue('ignored',{})
    state.trackers['NOVA-318']={issueKey:'NOVA-318',description:'Concurrent stop',activeSince:null,intervals:[{id:'only-interval',start:Date.now()-180000,end:Date.now()-60000}]}
    localStorage.setItem('fixture-state',JSON.stringify(state))
  })
  await page.getByRole('tab',{name:'Trackers',exact:true}).click()
  const second=await context.newPage()
  await launch(second)
  await second.getByRole('tab',{name:'Trackers',exact:true}).click()
  await Promise.all([page.getByRole('button',{name:'Stop & log'}).click(),second.getByRole('button',{name:'Stop & log'}).click()])
  await expect.poll(async()=>page.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem('fixture-state')!).trackers).length)).toBe(0)
  const total=(await page.evaluate(()=>(window as any).__requests.filter((r:any)=>r.method==='POST').length))+(await second.evaluate(()=>(window as any).__requests.filter((r:any)=>r.method==='POST').length))
  expect(total).toBe(1)
})

test('batch deletion keeps failed IDs and still attempts the next item',async ({page}) => {
  await launch(page)
  await page.evaluate(()=>{(window as any).__deleteFailId='931842'})
  await page.getByLabel('Select worklog 931842').check()
  await page.getByLabel('Select worklog 931859').check()
  page.once('dialog',d=>d.accept())
  await page.getByRole('button',{name:'Delete selected'}).click()
  await expect(page.getByRole('status')).toContainText('Could not delete: 931842')
  await expect(page.getByLabel('Select worklog 931842')).toBeVisible()
  await expect(page.getByLabel('Select worklog 931859')).toHaveCount(0)
})

test('required work attributes block writes and submit immutable dropdown values', async ({page}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await launch(page)
  await page.evaluate(() => {
    (window as any).__attributes = [
      { key: 'Task', name: 'Task', type: 'STATIC_LIST', required: true, values: ['task-dev-uid'], names: { 'task-dev-uid': 'Development <UI>' } },
      { key: '_Billable_', name: 'Billable', type: 'CHECKBOX', required: true },
      { key: '_Count_', name: 'Count', type: 'INPUT_NUMERIC', required: true }
    ]
  })
  await page.getByRole('button', {name: 'Refresh', exact: true}).click()
  await expect(page.getByLabel('Task (required)')).toBeVisible()
  await page.getByLabel('Duration or interval', {exact: true}).fill('35m')
  await page.getByRole('button', {name: 'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('Task is required')
  expect(await page.evaluate(() => (window as any).__requests.filter((r: any) => r.method === 'POST').length)).toBe(0)
  await expect(page.getByLabel('Duration or interval', {exact: true})).toHaveValue('35m')
  await page.getByLabel('Task (required)').selectOption({label: 'Development <UI>'})
  await page.getByLabel('Billable (required)').selectOption('false')
  await page.getByLabel('Count (required)').fill('0')
  await page.getByRole('tab', {name: 'Aliases', exact: true}).click()
  await page.getByRole('tab', {name: 'Worklogs', exact: true}).click()
  await expect(page.getByLabel('Task (required)')).toHaveValue('task-dev-uid')
  if (process.env.TEMPO_QA_DIR) {
    await page.getByRole('button', {name: 'Save worklog'}).scrollIntoViewIfNeeded()
    await page.screenshot({path: `${process.env.TEMPO_QA_DIR}/work-attributes-desktop.png`})
    await page.setViewportSize({width: 390, height: 844})
    await page.getByRole('button', {name: 'Save worklog'}).scrollIntoViewIfNeeded()
    await page.screenshot({path: `${process.env.TEMPO_QA_DIR}/work-attributes-mobile.png`})
  }
  await page.getByRole('button', {name: 'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('Saved 35m to NOVA-318')
  const body = await page.evaluate(() => JSON.parse((window as any).__requests.find((r: any) => r.method === 'POST').data))
  expect(body.attributes).toEqual([
    {key: 'Task', value: 'task-dev-uid'}, {key: '_Billable_', value: 'false'}, {key: '_Count_', value: '0'}
  ])
  expect(errors).toEqual([])
})

test('failed attribute loading keeps worklogs readable and can retry without losing input', async ({page}) => {
  await launch(page)
  await page.evaluate(() => { (window as any).__failAttributes = true })
  await page.getByRole('button', {name: 'Refresh', exact: true}).click()
  await expect(page.getByRole('button', {name: 'Load work attributes'})).toBeVisible()
  await expect(page.getByRole('link', {name: 'NOVA-318', exact: true})).toBeVisible()
  await page.getByLabel('Duration or interval', {exact: true}).fill('20m')
  await page.getByRole('button', {name: 'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('Unauthorized access to Tempo')
  expect(await page.evaluate(() => (window as any).__requests.filter((r: any) => r.method === 'POST').length)).toBe(0)
  await page.evaluate(() => {
    (window as any).__failAttributes = false
    ;(window as any).__attributes = [{key: 'Task', name: 'Task', type: 'INPUT_FIELD', required: true}]
  })
  await page.getByRole('button', {name: 'Load work attributes'}).click()
  await expect(page.getByLabel('Task (required)')).toBeVisible()
  await expect(page.getByLabel('Duration or interval', {exact: true})).toHaveValue('20m')
  await page.getByLabel('Task (required)').fill('Investigation')
  await page.getByRole('button', {name: 'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('Saved 20m')
})

test('tracker stop preserves intervals until required attributes are filled', async ({page}) => {
  await launch(page)
  await page.evaluate(() => {
    (window as any).__attributes = [{key: 'Task', name: 'Task', type: 'INPUT_FIELD', required: true}]
    const state = (window as any).GM_getValue('ignored', {})
    state.trackers['NOVA-318'] = {issueKey: 'NOVA-318', description: 'Tracked work', activeSince: null, intervals: [{id: 'pending', start: Date.now() - 180000, end: Date.now() - 60000}]}
    localStorage.setItem('fixture-state', JSON.stringify(state))
  })
  await page.getByRole('button', {name: 'Refresh', exact: true}).click()
  await page.getByRole('tab', {name: 'Trackers', exact: true}).click()
  await page.getByRole('button', {name: 'Stop & log'}).click()
  await expect(page.getByRole('status')).toContainText('Task is required')
  expect(await page.evaluate(() => (window as any).__requests.filter((r: any) => r.method === 'POST').length)).toBe(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-state')!).trackers['NOVA-318'].intervals.length)).toBe(1)
  await page.getByLabel('Task (required)').fill('Support')
  await page.getByRole('button', {name: 'Stop & log'}).click()
  await expect(page.getByRole('status')).toContainText('Logged all intervals')
  const body = await page.evaluate(() => JSON.parse((window as any).__requests.find((r: any) => r.method === 'POST').data))
  expect(body.attributes).toEqual([{key: 'Task', value: 'Support'}])
})

test('defaults to the last seven days, groups newest dates first and changes week presets', async ({page}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await launch(page)
  await expect(page.getByRole('combobox', {name: 'Date range', exact: true})).toHaveValue('recent')
  await expect(page.getByLabel('Worklog date', {exact: true})).toHaveValue('2026-09-20')
  await expect(page.getByLabel('Range summary')).toContainText('2026-09-14 – 2026-09-20')
  await page.evaluate(() => {
    const base = (window as any).__logs[0]
    ;(window as any).__logs.push(
      {...base, tempoWorklogId: 941001, startDate: '2026-09-14', timeSpentSeconds: 1800},
      {...base, tempoWorklogId: 941002, startDate: '2026-09-13', timeSpentSeconds: 3600},
      {...base, tempoWorklogId: 941003, startDate: '2026-09-20', timeSpentSeconds: 900},
      {...base, tempoWorklogId: 941004, startDate: '2026-09-21', timeSpentSeconds: 3600}
    )
  })
  await page.getByRole('button', {name: 'Refresh', exact: true}).click()
  await expect(page.getByLabel('Range summary')).toContainText('Selected range: 2h50m / 8h')
  expect(await page.locator('tbody[aria-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual([
    'Worklogs on 2026-09-20', 'Worklogs on 2026-09-19', 'Worklogs on 2026-09-14'
  ])
  await expect(page.getByRole('rowheader', {name: '2026-09-20 · Sunday · 15m', exact: true})).toBeVisible()
  await expect(page.getByRole('rowheader', {name: '2026-09-19 · Saturday · 2h5m', exact: true})).toBeVisible()
  await expect(page.getByRole('rowheader', {name: '2026-09-14 · Monday · 30m', exact: true})).toBeVisible()
  await expect(page.getByLabel('Select worklog 941002')).toHaveCount(0)
  await expect(page.getByLabel('Select worklog 941004')).toHaveCount(0)
  if (process.env.TEMPO_QA_DIR) {
    await page.screenshot({path: `${process.env.TEMPO_QA_DIR}/week-desktop.png`})
    await page.setViewportSize({width: 390, height: 844})
    await page.screenshot({path: `${process.env.TEMPO_QA_DIR}/week-mobile.png`})
  }
  await page.getByRole('combobox', {name: 'Date range', exact: true}).selectOption('previous')
  await expect(page.getByLabel('Range summary')).toContainText('2026-09-07 – 2026-09-13')
  await expect(page.getByLabel('Select worklog 941002')).toBeVisible()
  await expect(page.getByLabel('Select worklog 941003')).toHaveCount(0)
  await expect(page.getByLabel('Worklog date', {exact: true})).toHaveValue('2026-09-20')
  await page.getByRole('combobox', {name: 'Date range', exact: true}).selectOption('week')
  await expect(page.getByLabel('Range summary')).toContainText('2026-09-14 – 2026-09-20')
  expect(errors).toEqual([])
})

test('custom calendar range spans months and logging uses its independent date', async ({page}) => {
  await launch(page)
  await page.evaluate(() => {
    const base = (window as any).__logs[0]
    ;(window as any).__logs = [
      {...base, tempoWorklogId: 942001, startDate: '2026-08-31', timeSpentSeconds: 1800},
      {...base, tempoWorklogId: 942002, startDate: '2026-09-01', timeSpentSeconds: 3600},
      {...base, tempoWorklogId: 942003, startDate: '2026-08-10', timeSpentSeconds: 7200},
      {...base, tempoWorklogId: 942004, startDate: '2026-09-10', timeSpentSeconds: 7200}
    ]
    ;(window as any).__schedule = [
      {date: '2026-08-31', requiredSeconds: 14400, type: 'WORKING_DAY'},
      {date: '2026-08-10', requiredSeconds: 14400, type: 'WORKING_DAY'},
      {date: '2026-09-01', requiredSeconds: 28800, type: 'WORKING_DAY'},
      {date: '2026-09-10', requiredSeconds: 28800, type: 'WORKING_DAY'}
    ]
  })
  await page.getByRole('combobox', {name: 'Date range', exact: true}).selectOption('custom')
  await expect(page.getByLabel('From', {exact: true})).toHaveAttribute('type', 'date')
  await expect(page.getByLabel('To', {exact: true})).toHaveAttribute('type', 'date')
  await page.getByLabel('From', {exact: true}).fill('2026-08-31')
  await page.getByLabel('To', {exact: true}).fill('2026-09-01')
  await page.getByRole('button', {name: 'Apply dates'}).click()
  await expect(page.getByLabel('Range summary')).toContainText('Selected range: 1h30m / 12h')
  await expect(page.getByLabel('Select worklog 942003')).toHaveCount(0)
  await expect(page.getByLabel('Select worklog 942004')).toHaveCount(0)
  await page.getByText('Monthly progress', {exact: true}).click()
  await expect(page.locator('.monthly')).toContainText('2026-08: 2h30m / 8h')
  await expect(page.locator('.monthly')).toContainText('2026-09: 3h / 16h')
  const query = await page.evaluate(() => (window as any).__requests.filter((r: any) => r.url.includes('/worklogs/user/')).at(-1).url)
  expect(new URL(query).searchParams.get('from')).toBe('2026-08-01')
  expect(new URL(query).searchParams.get('to')).toBe('2026-09-30')
  await expect(page.getByLabel('Worklog date', {exact: true})).toHaveValue('2026-09-20')
  await page.getByLabel('Worklog date', {exact: true}).fill('2026-09-18')
  await page.getByLabel('Duration or interval', {exact: true}).fill('15m')
  await page.getByRole('button', {name: 'Save worklog'}).click()
  await expect(page.getByRole('status')).toContainText('on 2026-09-18')
  await expect(page.getByRole('status')).toContainText('outside the displayed range')
  await expect(page.getByLabel('Range summary')).toContainText('2026-08-31 – 2026-09-01')
  const body = await page.evaluate(() => JSON.parse((window as any).__requests.find((r: any) => r.method === 'POST').data))
  expect(body.startDate).toBe('2026-09-18')
})

test('invalid custom dates make no requests and failed refresh preserves the displayed range', async ({page}) => {
  await launch(page)
  await page.getByRole('combobox', {name: 'Date range', exact: true}).selectOption('custom')
  await page.getByLabel('From', {exact: true}).fill('2026-09-20')
  await page.getByLabel('To', {exact: true}).fill('2026-09-19')
  const before = await page.evaluate(() => (window as any).__requests.length)
  await page.getByRole('button', {name: 'Apply dates'}).click()
  await expect(page.locator('.status.error')).toBeVisible()
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(before)
  await page.getByLabel('From', {exact: true}).fill('')
  await page.getByRole('button', {name: 'Apply dates'}).click()
  expect(await page.evaluate(() => (window as any).__requests.length)).toBe(before)
  await page.evaluate(() => { (window as any).__failReads = true })
  await page.getByRole('combobox', {name: 'Date range', exact: true}).selectOption('previous')
  await expect(page.getByRole('status')).toContainText('Unauthorized access to Tempo')
  await expect(page.getByLabel('Range summary')).toContainText('2026-09-14 – 2026-09-20')
  await expect(page.getByLabel('Select worklog 931842')).toBeVisible()
})
