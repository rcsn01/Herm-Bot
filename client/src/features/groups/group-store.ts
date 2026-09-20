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

import { groupMemberKey, groupRoomKey, type GroupMember, type GroupMessage, type GroupMessageAuthor, type GroupRoom } from './group-model'

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

export function recordGroupActivity(roomKey: string, event: Omit<GroupActivityEntry, 'at' | 'epoch'>): void {
  const entry: GroupActivityEntry = {
    ...event,
    at: Date.now(),
    epoch: getRoomEpoch(roomKey)
  }
  const all = $groupActivity.get()
  const list = [...(all[roomKey] || []), entry]
  $groupActivity.set({ ...all, [roomKey]: list.slice(-GROUP_ACTIVITY_LIMIT) })
}

function getRoomEpoch(roomKey: string): number {
  return $groupChats.get()[roomKey]?.epoch || 0
}

/** A pending clarify question / command approval blocking inside a member's
 * session, mirrored into a room card (#90694). */
export interface GroupPrompt {
  at: number
  choices?: string[]
  command?: string
  roomKey: string
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

const STORAGE_KEY = 'hermes.group-chats.v3'

/** The pre-re-key copy: read only when v3 is absent, left in place as a
 *  rollback snapshot — never written, never read once v3 exists. */
const STORAGE_KEY_V2 = 'hermes.group-chats.v2'

/** The pre-migration copy: read only when v2 is absent, left in place as a
 *  rollback snapshot — never written, never read once v2 exists. */
const STORAGE_KEY_V1 = 'hermes.group-chats.v1'

/** Coordination maps are keyed by the current member rows' keys. When a row
 *  gains a connectionId (desktop projection arrives, v1 state loaded), move
 *  its coordination state from the bare key to the qualified key. Never moves
 *  qualified → bare, and never overwrites an existing qualified entry. Also
 *  carries the runtime turn indicator, so a mid-turn enrichment keeps the
 *  stop/interrupt path and the room display on the member's current key. */
export function rekeyRoomCoordination(room: GroupChatRoom): GroupChatRoom {
  const next: GroupChatRoom = {
    ...room,
    holds: { ...(room.holds || {}) },
    sessions: { ...(room.sessions || {}) },
    stranded: { ...(room.stranded || {}) },
    watermarks: { ...room.watermarks }
  }
  const hasKey = (map: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(map, key)
  let changed = false

  for (const member of Array.isArray(room.members) ? room.members : []) {
    if (!member?.connectionId || !member.name) continue
    const bareKey = member.name
    const qualifiedKey = `${member.connectionId}::${member.name}`

    const holds = { ...(next.holds || {}) }
    if (!hasKey(holds, qualifiedKey) && hasKey(holds, bareKey)) {
      holds[qualifiedKey] = holds[bareKey]
      delete holds[bareKey]
      next.holds = holds
      changed = true
    }

    const sessions = { ...(next.sessions || {}) }
    if (!hasKey(sessions, qualifiedKey) && hasKey(sessions, bareKey)) {
      sessions[qualifiedKey] = sessions[bareKey]
      delete sessions[bareKey]
      next.sessions = sessions
      changed = true
    }

    const stranded = { ...(next.stranded || {}) }
    if (!hasKey(stranded, qualifiedKey) && hasKey(stranded, bareKey)) {
      stranded[qualifiedKey] = stranded[bareKey]
      delete stranded[bareKey]
      next.stranded = stranded
      changed = true
    }

    // Watermark keys are `${thread}::${memberKey}`. Thread ids are minted
    // `t…` or `legacy` and never contain `::`, so the FIRST `::` separates
    // thread from member key even when a qualified member key carries its
    // own `::` (a right split would mistag an already-qualified member's
    // persisted key as bare).
    for (const [key, value] of Object.entries(next.watermarks)) {
      const split = key.indexOf('::')
      if (split === -1) continue
      const memberPart = key.slice(split + 2)
      if (memberPart !== bareKey) continue
      const target = `${key.slice(0, split)}::${qualifiedKey}`
      if (hasKey(next.watermarks, target)) continue
      next.watermarks[target] = value
      delete next.watermarks[key]
      changed = true
    }

    if (next.turn === bareKey) {
      next.turn = qualifiedKey
      changed = true
    }
  }

  return changed ? next : room
}

/** Re-key a name-keyed persistence map to durable room keys. Two rooms
 *  colliding on re-key is structurally impossible (roomIds are unique, names
 *  are unique per room set), so the guard only documents the impossibility:
 *  when the canonical key is already occupied, the entry is skipped rather
 *  than inventing resolution policy. */
function rekeyRoomMapKeys(rooms: Record<string, GroupChatRoom>): Record<string, GroupChatRoom> {
  const next: Record<string, GroupChatRoom> = {}
  for (const room of Object.values(rooms)) {
    const key = groupRoomKey(room.name, room)
    if (next[key]) continue
    next[key] = room
  }
  return next
}

function loadPersistedRooms(): Record<string, GroupChatRoom> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, GroupChatRoom>
      // v3 loading runs no migration — the pass already executed before this
      // copy was written.
      return typeof parsed !== 'object' || parsed === null ? {} : parsed
    }
    // v2 is the pre-re-key copy: its coordination state is guaranteed
    // post-member-re-key (the only build that wrote v2 always ran
    // rekeyRoomCoordination at load), so only the map re-key runs. v2 stays
    // in place as the rollback snapshot — v3 is written on the next persist.
    const v2 = localStorage.getItem(STORAGE_KEY_V2)
    if (v2) {
      const parsed = JSON.parse(v2) as Record<string, GroupChatRoom>
      if (typeof parsed !== 'object' || parsed === null) return {}
      return rekeyRoomMapKeys(parsed)
    }
    // v1 is the pre-migration copy: run the durable shape guards, carry the
    // coordination state to the current member keys, re-key the map to
    // durable room keys, and keep v1 in place — v3 is written on the next
    // persist.
    const v1 = localStorage.getItem(STORAGE_KEY_V1)
    if (!v1) return {}
    const parsed = JSON.parse(v1) as Record<string, GroupChatRoom>
    if (typeof parsed !== 'object' || parsed === null) return {}
    const guarded = durableGroupChatRooms(parsed)
    return rekeyRoomMapKeys(
      Object.fromEntries(
        Object.entries(guarded).map(([key, room]) => [key, rekeyRoomCoordination(room)])
      )
    )
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

/** The missing-room stub for an unknown key: fields derive from the key so
 *  the stub's identity agrees with its own map key (`name:` → display part;
 *  `id:` → roomId from the key, display name = the raw key). Documented
 *  defensive path — the drive always has an adopted room. */
function stubRoomFromKey(roomKey: string): GroupChatRoom {
  if (roomKey.startsWith('id:')) {
    return { name: roomKey, roomId: roomKey.slice(3), log: [], members: [], watermarks: {}, epoch: 0, running: false }
  }
  if (roomKey.startsWith('name:')) {
    return { name: roomKey.slice(5), log: [], members: [], watermarks: {}, epoch: 0, running: false }
  }
  return { name: roomKey, log: [], members: [], watermarks: {}, epoch: 0, running: false }
}

/** Mutate one room through the atom, trim, persist, and schedule a mirror sync. */
export function updateGroupChat(
  roomKey: string,
  mutate: (room: GroupChatRoom) => GroupChatRoom,
  { sync = true }: UpdateGroupChatOptions = {}
): GroupChatRoom {
  const all = { ...$groupChats.get() }
  const current: GroupChatRoom = all[roomKey] || stubRoomFromKey(roomKey)
  const next = mutate({ ...current, log: [...current.log], watermarks: { ...current.watermarks } })
  const bounded = trimGroupChatLog(next.log, next.watermarks)
  next.log = bounded.log
  next.watermarks = bounded.watermarks
  all[roomKey] = next
  $groupChats.set(all)
  persistRooms(all)
  if (sync) scheduleSync?.(roomKey)
  return next
}

export function getGroupRoom(roomKey: string): GroupChatRoom {
  return $groupChats.get()[roomKey] || stubRoomFromKey(roomKey)
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

export function appendGroupChatEntry(roomKey: string, from: GroupMessageAuthor, text: string, thread?: null | string): GroupMessage {
  const entry: GroupMessage = {
    at: Date.now(),
    from,
    id: groupChatEntryId(),
    text: normalizeGroupChatText(text),
    thread: thread || 'legacy'
  }
  const priorLog = getGroupRoom(roomKey).log
  const lastEntry = priorLog[priorLog.length - 1]
  if (isDuplicateGroupAppend(lastEntry, from, entry.text, entry.thread)) return lastEntry

  updateGroupChat(roomKey, room => {
    room.log.push(entry)
    return room
  })

  // Needs-you: a member addressing @user badges the room header.
  if (from.kind === 'member' && /@user\b/i.test(entry.text)) {
    $groupNeedsYou.set({ ...$groupNeedsYou.get(), [roomKey]: true })
  }

  return entry
}

/** Move one room's runtime feed state to a new room key — the sweep for a
 *  name-keyed room's remote rename that rides the old envelope key (the
 *  id-keyed class never moves, so this never fires for it). Appends to the
 *  target's activity list and never overwrites a non-empty target-side
 *  entry, so a re-applied merge cannot duplicate or clobber. */
export function renameRoomState(previousKey: string, nextKey: string): void {
  if (previousKey === nextKey) return

  const activity = $groupActivity.get()
  if (activity[previousKey]) {
    const next = { ...activity }
    next[nextKey] = [...(next[nextKey] || []), ...next[previousKey]].slice(-GROUP_ACTIVITY_LIMIT)
    delete next[previousKey]
    $groupActivity.set(next)
  }

  const prompts = $groupPrompts.get()
  const prefix = `${previousKey}::`
  const moved = Object.entries(prompts).filter(([key]) => key.startsWith(prefix))
  if (moved.length) {
    const next = { ...prompts }
    for (const [key, prompt] of moved) {
      delete next[key]
      const targetKey = `${nextKey}${key.slice(previousKey.length)}`
      if (!next[targetKey]) next[targetKey] = { ...prompt, roomKey: nextKey }
    }
    $groupPrompts.set(next)
  }

  const needsYou = $groupNeedsYou.get()
  if (Object.prototype.hasOwnProperty.call(needsYou, previousKey)) {
    const next = { ...needsYou }
    const value = next[previousKey]
    delete next[previousKey]
    if (!next[nextKey]) next[nextKey] = value
    $groupNeedsYou.set(next)
  }
}

/** Adopt a mirror row into the engine store on room open (local, no RPC):
 *  a room this client has never driven starts with watermarks at zero,
 *  exactly like the desktop's mergeRemoteGroupChatSnapshotIntoRooms seeds a
 *  fresh local twin. The row is keyed by its durable room key; an `id:`-keyed
 *  row backfills its roomId from the key so the map-key invariant holds. */
export function adoptMirrorRoom(room: GroupRoom): void {
  const all = $groupChats.get()
  if (all[room.key]) return
  replaceGroupChats({
    ...all,
    [room.key]: {
      name: room.name,
      roomId: room.roomId ?? (room.key.startsWith('id:') ? room.key.slice(3) : null),
      log: [...room.log],
      members: [...room.members],
      watermarks: {},
      epoch: 0,
      running: false
    }
  })
}
