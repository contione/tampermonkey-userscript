import { beforeEach, afterEach, expect, test, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('location', { hostname: 'demo.atlassian.net' })
  vi.stubGlobal('GM_getValue', vi.fn((_key, fallback) => fallback))
  vi.stubGlobal('GM_setValue', vi.fn())
  vi.stubGlobal('GM', { getValue: async (_key: string, fallback: unknown) => fallback, setValue: async (key: string, value: unknown) => GM_setValue(key, value) })
})
afterEach(() => vi.unstubAllGlobals())

test('storage keys isolate Jira sites and reads do not share mutable references', async () => {
  const { readState, saveState } = await import('../src/store')
  const state = readState()
  state.aliases.review = 'NOVA-318'
  expect(readState().aliases).toEqual({})
  saveState(state)
  expect(vi.mocked(GM_setValue)).toHaveBeenCalledWith('tempo:v1:demo.atlassian.net', state)
})

test('writes require a multi-tab lock and checkpoint only explicitly', async () => {
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_key, callback) => callback()) } })
  const { transaction } = await import('../src/store')
  await transaction(async (state, save) => { state.aliases.review = 'NOVA-318'; await save() })
  expect(navigator.locks.request).toHaveBeenCalledWith('tempo:v1:demo.atlassian.net', expect.any(Function))
  expect(vi.mocked(GM_setValue)).toHaveBeenCalledTimes(1)
})

test('does not overwrite unknown stored versions', async () => {
  vi.stubGlobal('GM_getValue', vi.fn(() => ({version: 42})))
  const { readState } = await import('../src/store')
  expect(() => readState()).toThrow('not compatible')
  expect(vi.mocked(GM_setValue)).not.toHaveBeenCalled()
})

declare function GM_setValue(key: string, value: unknown): void
