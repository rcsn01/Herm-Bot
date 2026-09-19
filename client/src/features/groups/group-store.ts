/**
 * The PWA's local group-room store — the port of the desktop Bot Mode's
 * `$groupChats` (apps/desktop/src/plugins/hermes-bots/group-chat.ts). The
 * gateway mirror under `ui_meta['hermes-bots-groups']` is the shared
 * projection; THIS store is the working copy the send engine mutates:
 * watermarks, member plumbing-session ids, stop holds, stranded markers,
 * and the room epoch never ride the wire — they are local coordination
 * state, persisted to localStorage like the desktop persists to plugin
 * storage.
 *
 * This file also hosts the engine's runtime-only feed atoms (room activity,
 * pending prompts) and the shared raw transport type lives in group-model —
 * they sit beside the rooms (not in group-engine) so the append and turn
 * paths can write them without an import cycle.
 */

import { atom } from 'nanostores'

import type { GroupMember, GroupMessage, GroupMessageAuthor } from './group-model'

/** Every ceiling a single user send can spend — same values the desktop
 *  ships (group-chat.ts GROUP_CHAT_MAX_*), one block on purpose. */
export const GROUP_CHAT_MAX_ROUNDS = 3
export const GROUP_CHAT_MAX_MESSAGES = 10
export const GROUP_CHAT_MAX_CONTINUATIONS = 2
export const GROUP_CHAT_HISTORY_LIMIT = 24
export const GROUP_CHAT_MAX_MEMBERS = 6

/** Log retention: watermarks stay index-consistent with the trimmed array. */
export const GROUP_LOG_RETAIN = GROUP_CHAT_HISTORY_LIMIT * 4

export interface GroupHoldStamp {
  at?: number
  byMessageId?: null | string
  noted?: boolean
  thread?: null | string
}

/** The room record as the send engine handles it. `sessions` maps memberKey
 *  → durable plumbing-session id; `watermarks` are per `${thread}::${member}`. */
export interface GroupChatRoom {
  epoch: number
  holds?: Record<string, GroupHoldStamp>
  image?: null | string
  log: GroupMessage[]
  members: Array<GroupMember & { connectionId?: string; connectionKind?: string; connectionLabel?: string; sourceScoped?: boolean }>
  name: string
  roomId?: null | string
  running: boolean
  sessions?: Record<string, string>
  stranded?: Record<string, number | { before: number; thread: string }>
  syncRevision?: number
  turn?: null | string
  watermarks: Record<string, number>
}

const STORAGE_KEY = 'hermes.group-chats.v1'

/** Groups whose latest room activity mentions @user — the needs-you badge.
 *  Lives beside the rooms (not in group-engine) so the append path can set
 *  it without an import cycle. */
export const $groupNeedsYou = atom<Record<string, boolean>>({})

export const $groupChats = atom<Record<string, GroupChatRoom>>({})

/** Room activity feed — the "queued/working/passed/replied/settled…" lines
 * the desktop renders under the room (group-activity.ts). Runtime-only state,
 * kept beside the rooms (not in group-engine) so the append path can record
 * it without an import cycle. */
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
 * session, mirrored into a room card (#90694). */
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

export function groupThreadOf(entry: GroupMessage): string {
  return entry?.thread || 'legacy'
}

export function mintGroupThreadId(): string {
  return `t${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Fresh room identity independent of the editable display name. */
export function mintGroupRoomId(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** Keep recreated rooms distinct without silently reopening an old room. */
export function uniqueGroupChatName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let number = 2; number < 100; number += 1) {
    const suffix = ` ${number}`
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error('No free name for the group chat.')
}

function groupChatEntryId(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID().slice(0, 24)
  }
  return `e${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
}

function normalizeGroupChatText(text: string): string {
  const trimmed = String(text || '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim()

  // The agent loop's "(empty)" terminal sentinel (empty_response_exhausted) is
  // a FAILURE marker, never bot text. Mirror the gateway's user-friendly
  // substitution so the room log never shows the raw sentinel.
  return trimmed === '(empty)' ? GROUP_EMPTY_FRIENDLY : trimmed
}

const GROUP_EMPTY_FRIENDLY =
  '⚠️ The model returned no response after processing tool results. ' +
  'This can happen with some models — try again or rephrase your question.'

/** Stable per-member identity inside a room. Local members keep their bare
 *  name; source-qualified remote members get the connection-qualified key
 *  (group-membership.ts groupMemberKey) so same-named agents on two
 *  machines never share watermarks or sessions. */
export function groupMemberKey(member: { connectionId?: string; name: string; sourceScoped?: boolean }): string {
  return member?.sourceScoped && member?.connectionId ? `${member.connectionId}::${member.name}` : member?.name
}

/** Transcript form of a speaker's name: 'default' reads as Hermes, matching
 *  the roster label (group-chat.ts groupSpeakerLabel — the meta-title rung
 *  is applied by callers that hold a roster). */
export function groupSpeakerLabel(name?: null | string): string {
  const trimmed = (name || '').trim()
  return !trimmed ? trimmed : trimmed.toLowerCase() === 'default' ? 'Hermes' : trimmed
}

function trimGroupChatLog(log: GroupMessage[], watermarks: Record<string, number>, limit = GROUP_LOG_RETAIN) {
  if (log.length <= limit) return { log, watermarks }
  const drop = log.length - limit
  const trimmed: Record<string, number> = {}
  for (const [name, index] of Object.entries(watermarks || {})) {
    trimmed[name] = Math.max(0, index - drop)
  }
  return { log: log.slice(drop), watermarks: trimmed }
}

function loadPersistedRooms(): Record<string, GroupChatRoom> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, GroupChatRoom>
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed
  } catch {
    return {}
  }
}

function persistRooms(all: Record<string, GroupChatRoom>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(durableGroupChatRooms(all)))
  } catch {
    /* storage unavailable — rooms survive for this session only */
  }
}

/** The durable persistence shape for `all`: runtime-only coordination state
 *  (running, turn) is stripped and empty-log stubs without a durable identity
 *  are dropped, so a rehydrated store only ever contains real rooms. */
export function durableGroupChatRooms(all: Record<string, GroupChatRoom>): Record<string, GroupChatRoom> {
  const durable: Record<string, GroupChatRoom> = {}
  for (const [key, room] of Object.entries(all)) {
    const members = Array.isArray(room.members) ? room.members : []
    // A newly-created room has no transcript yet, but its durable identity
    // and membership make it a real local room rather than a runtime stub.
    // Keep it locally; the gateway projection still omits empty rooms until
    // the first message gives other clients something to mirror.
    if (!Array.isArray(room.log) || (room.log.length === 0 && (!room.roomId || members.length === 0))) continue
    durable[key] = {
      epoch: room.epoch || 0,
      holds: room.holds || {},
      image: room.image || null,
      log: room.log,
      members,
      name: room.name,
      roomId: typeof room.roomId === 'string' && room.roomId ? room.roomId : null,
      running: false,
      sessions: room.sessions || {},
      stranded: room.stranded || {},
      syncRevision: Math.max(0, Number(room.syncRevision || 0)),
      turn: null,
      watermarks: room.watermarks || {}
    }
  }
  return durable
}

$groupChats.set(loadPersistedRooms())

export interface UpdateGroupChatOptions {
  /** false skips scheduling a mirror sync (pure runtime state changes). */
  sync?: boolean
}

type SyncScheduler = (changedRoom: string) => void

let scheduleSync: SyncScheduler | null = null

/** The mirror writer registers itself here so every durable room mutation
 *  schedules a gateway sync — the port of the desktop's
 *  scheduleGroupChatServerSync. */
export function setGroupSyncScheduler(scheduler: SyncScheduler | null): void {
  scheduleSync = scheduler
}

/** Mutate one room through the atom, trim, persist, and schedule a mirror sync. */
export function updateGroupChat(
  group: string,
  mutate: (room: GroupChatRoom) => GroupChatRoom,
  { sync = true }: UpdateGroupChatOptions = {}
): GroupChatRoom {
  const all = { ...$groupChats.get() }
  const current: GroupChatRoom = all[group] || { name: group, log: [], watermarks: {}, epoch: 0, running: false }
  const next = mutate({ ...current, log: [...current.log], watermarks: { ...current.watermarks } })
  const bounded = trimGroupChatLog(next.log, next.watermarks)
  next.log = bounded.log
  next.watermarks = bounded.watermarks
  all[group] = next
  $groupChats.set(all)
  persistRooms(all)
  if (sync) scheduleSync?.(group)
  return next
}

export function getGroupRoom(group: string): GroupChatRoom {
  return $groupChats.get()[group] || { name: group, log: [], watermarks: {}, epoch: 0, running: false }
}

/** Wholesale replace (mirror pull / sync read-back): set + persist. */
export function replaceGroupChats(rooms: Record<string, GroupChatRoom>): void {
  $groupChats.set(rooms)
  persistRooms(rooms)
}

/** Byte-identical member echo guard (#93127): a residual double-append lands
 *  back-to-back; drop it instead of flooding the room. User entries and
 *  non-adjacent repeats are never touched. */
const GROUP_DUPLICATE_APPEND_WINDOW_MS = 10 * 60 * 1000

function isDuplicateGroupAppend(
  lastEntry: GroupMessage | undefined,
  from: GroupMessageAuthor,
  text: string,
  thread: null | string | undefined,
  now = Date.now()
): boolean {
  if (!lastEntry || !from || from.kind !== 'member' || lastEntry.from?.kind !== 'member') return false
  if (String(lastEntry.from?.name || '') !== String(from.name || '')) return false
  if (String(lastEntry.from?.source || '') !== String(from.source || '')) return false
  if (String(groupThreadOf(lastEntry)) !== String(thread || 'legacy')) return false
  if (now - (lastEntry.at || 0) > GROUP_DUPLICATE_APPEND_WINDOW_MS) return false
  return String(lastEntry.text || '') === String(text || '').trim()
}

export function appendGroupChatEntry(group: string, from: GroupMessageAuthor, text: string, thread?: null | string): GroupMessage {
  const entry: GroupMessage = {
    at: Date.now(),
    from,
    id: groupChatEntryId(),
    text: normalizeGroupChatText(text),
    thread: thread || 'legacy'
  }
  const priorLog = getGroupRoom(group).log
  const lastEntry = priorLog[priorLog.length - 1]
  if (isDuplicateGroupAppend(lastEntry, from, entry.text, entry.thread)) return lastEntry

  updateGroupChat(group, room => {
    room.log.push(entry)
    return room
  })

  // Needs-you: a member addressing @user badges the group header.
  if (from.kind === 'member' && /@user\b/i.test(entry.text)) {
    $groupNeedsYou.set({ ...$groupNeedsYou.get(), [group]: true })
  }

  return entry
}
/** Adopt a mirror row into the engine store on room open (local, no RPC):
 *  a room this client has never driven starts with watermarks at zero,
 *  exactly like the desktop's mergeRemoteGroupChatSnapshotIntoRooms seeds a
 *  fresh local twin. */
export function adoptMirrorRoom(room: { log: GroupMessage[]; members: GroupMember[]; name: string; roomId?: null | string }): void {
  const all = $groupChats.get()
  if (all[room.name]) return
  replaceGroupChats({
    ...all,
    [room.name]: {
      name: room.name,
      roomId: room.roomId ?? null,
      log: [...room.log],
      members: [...room.members],
      watermarks: {},
      epoch: 0,
      running: false
    }
  })
}
