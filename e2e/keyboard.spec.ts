import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

const script = readFileSync('dist/tempo.user.js', 'utf8')
const fixture = readFileSync('e2e/fixture.js', 'utf8')
const html = readFileSync('e2e/jira.html', 'utf8')

async function launch(page: Page) {
  await page.clock.setFixedTime(new Date('2026-09-20T10:00:00+02:00'))
  await page.route('https://demo.atlassian.net/**', route => route.fulfill({ contentType: 'text/html', body: html }))
  // One init script guarantees document-start registration before the simulated
  // Jira handlers, including handlers in the window/document capture phase.
  await page.addInitScript({content: `${fixture}\n${script}\n(${(() => {
    (window as any).__jiraKeys = []
    for (const target of [window, document]) {
      for (const capture of [true, false]) {
        for (const type of ['keydown', 'keypress', 'keyup']) {
          target.addEventListener(type, event => {
            const key = (event as KeyboardEvent).key
            ;(window as any).__jiraKeys.push(key)
            if (key === 'r') location.hash = 'jira-shortcut-fired'
          }, capture)
        }
      }
    }
  }).toString()})();`})
  await page.goto('https://demo.atlassian.net/browse/NOVA-318')
  await page.getByRole('button', {name: 'Open Tempo'}).click()
  await expect(page.getByRole('status')).toContainText('Worklogs refreshed')
}

test('typing, editing and composition stay in Tempo while Jira shortcuts work outside', async ({page}) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await launch(page)
  const description = page.getByLabel('Description', {exact: true})
  await description.pressSequentially('cegr?')
  await expect(description).toHaveValue('cegr?')
  await description.press('ArrowLeft')
  await description.press('Backspace')
  await expect(description).toHaveValue('ceg?')
  await description.press('ControlOrMeta+a')
  await description.pressSequentially('Draft')
  await expect(description).toHaveValue('Draft')
  await description.dispatchEvent('compositionstart', {bubbles: true, composed: true, data: '中'})
  await description.dispatchEvent('keydown', {key: 'Escape', keyCode: 229, isComposing: true, bubbles: true, composed: true})
  await expect(page.getByRole('region', {name: 'Tempo panel'})).toBeVisible()
  await page.keyboard.insertText('中文')
  await description.dispatchEvent('compositionend', {bubbles: true, composed: true, data: '中文'})
  await expect(description).toHaveValue('Draft中文')
  await description.press('Tab')
  await expect(description).not.toBeFocused()
  expect(await page.evaluate(() => (window as any).__jiraKeys)).toEqual([])
  expect(new URL(page.url()).hash).toBe('')
  await description.press('Escape')
  await expect(page.getByRole('button', {name: 'Open Tempo'})).toBeVisible()
  await page.getByRole('heading', {name: 'Improve webhook retry handling'}).click()
  await page.keyboard.press('r')
  expect(await page.evaluate(() => (window as any).__jiraKeys.length)).toBeGreaterThan(0)
  expect(new URL(page.url()).hash).toBe('#jira-shortcut-fired')
  expect(errors).toEqual([])
})

test('Enter inserts a textarea newline and submits the worklog form only once', async ({page}) => {
  await launch(page)
  const description = page.getByLabel('Description', {exact: true})
  await description.fill('First')
  await description.press('Enter')
  await description.pressSequentially('Second')
  await expect(description).toHaveValue('First\nSecond')
  expect(await page.evaluate(() => (window as any).__requests.filter((r: any) => r.method === 'POST').length)).toBe(0)
  const duration = page.getByLabel('Duration or interval', {exact: true})
  await duration.fill('10m')
  await duration.press('Enter')
  await expect(page.getByRole('status')).toContainText('Saved 10m')
  expect(await page.evaluate(() => (window as any).__requests.filter((r: any) => r.method === 'POST').length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__jiraKeys)).toEqual([])
})

test('remote updates preserve the focused editor and caret, then render after editing', async ({page}) => {
  await launch(page)
  await page.getByRole('tab', {name: 'Aliases', exact: true}).click()
  const alias = page.getByLabel('Alias', {exact: true})
  await alias.fill('draft')
  await alias.evaluate((node: HTMLInputElement) => {
    (window as any).__editing = node
    node.setSelectionRange(2, 2)
    const state = (window as any).GM_getValue('ignored', {})
    state.aliases.remote = 'OPS-42'
    localStorage.setItem('fixture-state', JSON.stringify(state))
    window.dispatchEvent(new StorageEvent('storage', {key: 'fixture-state'}))
  })
  await page.waitForTimeout(1100)
  expect(await alias.evaluate((node: HTMLInputElement) => ({same: node === (window as any).__editing, caret: node.selectionStart}))).toEqual({same: true, caret: 2})
  await expect(alias).toBeFocused()
  await alias.pressSequentially('X')
  await expect(alias).toHaveValue('drXaft')
  await page.getByRole('tab', {name: 'Aliases', exact: true}).focus()
  await expect(page.getByRole('cell', {name: 'remote', exact: true})).toBeVisible()
  await expect(alias).toHaveValue('drXaft')
})
