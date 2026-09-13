/**
 * The group engine's gateway access + runtime coordination stores. The
 * desktop's engine reaches members through requestForBot route sockets
 * (apps/desktop/src/plugins/hermes-bots/routing.ts); every member on this
 * gateway is reachable from the PWA's single transport with the profile
 * riding the RPC params, so the engine takes the transport as an injection
 * (configured by the gateway controller) instead of importing one.
 */

import { atom } from 'nanostores'

import { $groupChats, $groupNeedsYou } from './group-store'

export type GroupEngineRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>

let engineRequest: GroupEngineRequest | null = null

/** The gateway controller installs its runtime here on connect and clears it
 *  on scope teardown — a profile switch must not leave turns firing at a dead
 *  transport. */
export function setGroupEngineRequest(request: GroupEngineRequest | null): void {
  engineRequest = request
}

export function groupEngineRequest(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!engineRequest) throw new Error('Group engine transport is not connected.')
  return engineRequest(method, params)
}

/** Room activity feed — the "queued/working/passed/replied/settled…" lines
 *  the desktop renders under the room (group-activity.ts). Runtime-only. */
export interface GroupActivityEntry {
  at: number
  epoch: number
  kind: 'cancelled' | 'capped' | 'delivered' | 'failed' | 'held' | 'passed' | 'queued' | 'replied' | 'settled' | 'stopped' | 'timed-out' | 'working'
  member: null | string
  reason?: string
  thread: null | string
}

export const $groupActivity = atom<Record<string, GroupActivityEntry[]>>({})
const GROUP_ACTIVITY_LIMIT = 30

export function recordGroupActivity(group: string, event: Omit<GroupActivityEntry, 'at' | 'epoch'>): void {
  const entry: GroupActivityEntry = {
    ...event,
    at: Date.now(),
    epoch: getRoomEpoch(group)
  }
  const all = $groupActivity.get()
  const list = [...(all[group] || []), entry]
  $groupActivity.set({ ...all, [group]: list.slice(-GROUP_ACTIVITY_LIMIT) })
}

function getRoomEpoch(group: string): number {
  return $groupChats.get()[group]?.epoch || 0
}

/** A pending clarify question / command approval blocking inside a member's
 *  session, mirrored into a room card (#90694). */
export interface GroupPrompt {
  at: number
  choices?: string[]
  command?: string
  group: string
  kind: 'approval' | 'clarify'
  member: string
  memberKey: string
  multiSelect?: boolean
  question: string
  questions?: Array<Record<string, unknown>> | null
  requestId: string
  sessionId?: null | string
}

export const $groupPrompts = atom<Record<string, GroupPrompt>>({})

/** Room badges: a member addressing @user or blocking on a question. The
 *  badge lives beside the rooms (group-store) so the append path can set it
 *  without an import cycle; re-exported here for engine consumers. */
export { $groupNeedsYou }

export function clearGroupNeedsYou(group: string): void {
  const all = $groupNeedsYou.get()
  if (!all[group]) return
  const next = { ...all }
  delete next[group]
  $groupNeedsYou.set(next)
}