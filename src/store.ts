import type { Credentials } from './api'
import type { Tracker } from './domain'

declare function GM_getValue<T>(key: string, fallback: T): T
declare function GM_setValue<T>(key: string, value: T): void
declare function GM_addValueChangeListener(key: string, listener: () => void): number
declare const GM: { getValue<T>(key: string, fallback: T): Promise<T>; setValue<T>(key: string, value: T): Promise<void> }

export type State = { version: 1; credentials?: Credentials; aliases: Record<string, string>; trackers: Record<string, Tracker> }
const key = `tempo:v1:${location.hostname}`
export function readState(): State {
  const state = GM_getValue<State>(key, { version: 1, aliases: {}, trackers: {} })
  if (state.version !== 1 || !state.aliases || !state.trackers) throw new Error('Stored data is not compatible with this version.')
  return structuredClone(state)
}
export function saveState(state: State): void { GM_setValue(key, structuredClone(state)) }
export function subscribe(listener: () => void): void { GM_addValueChangeListener(key, listener) }
export async function transaction<T>(action: (state: State, save: () => Promise<void>) => Promise<T> | T): Promise<T> {
  if (!navigator.locks) throw new Error('This browser does not support safe multi-tab writes. Please update your browser.')
  return navigator.locks.request(key, async () => {
    const state = await GM.getValue<State>(key, { version: 1, aliases: {}, trackers: {} })
    if (state.version !== 1 || !state.aliases || !state.trackers) throw new Error('Stored data is not compatible with this version.')
    return action(state, () => GM.setValue(key, structuredClone(state)))
  })
}
