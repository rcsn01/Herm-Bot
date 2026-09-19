/**
 * The Group engine's runtime-only atoms and shared raw transport type. The
 * engine creates per-lifecycle member and mirror adapters from the injected
 * callback; this file does not own a mutable transport slot.
 *
 * File-exports only — the facade (group-engine.ts) re-exports the read surface,
 * while in-cluster modules own the state writes.
 */

import { atom } from 'nanostores'

import { $groupChats } from './group-store'

export type GroupEngineRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { signal?: AbortSignal }
) => Promise<unknown>

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