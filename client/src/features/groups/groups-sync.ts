/**
 * The group-chat mirror writer — the PWA's port of the desktop Bot Mode's
 * sync half (apps/desktop/src/plugins/hermes-bots/group-chat.ts): a bounded,
 * display-oriented projection of the local rooms under the DEFAULT profile's
 * `ui_meta['hermes-bots-groups']`, written through the gateway's
 * read-merge-CAS-write protocol (`ui_meta_expected_revisions` + read-back),
 * so desktop and PWA edits merge idempotently instead of clobbering.
 *
 * Mobile writes the SAME protocol on ONE transport: the desktop fans out to
 * every reachable default-profile gateway connection — the PWA has a single
 * connection per scope, so the per-connection job maps collapse.
 */

import type { GroupMember, GroupMessage } from './group-model'
import { groupEngineRequest } from './group-runtime'
import { $groupChats, replaceGroupChats, type GroupChatRoom } from './group-store'

const GROUP_CHAT_SYNC_META_KEY = 'hermes-bots-groups'
const GROUP_CHAT_SYNC_MAX_BYTES = 48000
const GROUP_CHAT_SYNC_MESSAGES = 16
const GROUP_CHAT_SYNC_TEXT_CHARS = 1200
const GROUP_CHAT_SYNC_IMAGE_CHARS = 24000

/** #94478: threadless entries separated by more than this lull start new
 *  synthetic `legacy-N` threads. */
const GROUP_THREAD_GAP_MS = 15 * 60000

export interface GroupChatSyncRoom {
  image?: string
  log: GroupMessage[]
  members?: GroupMember[]
  name: string
  roomId?: string
  revision: number
}

export interface GroupChatSyncSnapshot {
  deleted?: Record<string, number>
  rooms: Record<string, GroupChatSyncRoom>
  updatedAt?: number
  version: number
}

/** The wire size the gateway charges for JSON in its ui_meta budget: every
 *  `,`/`:` counts double and non-ASCII costs its escaped width. */
export function groupChatGatewayJsonSize(value: unknown): number {
  const json = JSON.stringify(value)
  let bytes = 0

  for (const character of json) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x7f) {
      bytes += 1
      if (character === ',' || character === ':') bytes += 1
    } else {
      bytes += codePoint <= 0xffff ? 6 : 12
    }
  }

  return bytes
}

/** Durable room identity for the sync projection: `id:<roomId>` when the
 *  room carries one (rename = field update, tombstones follow the room),
 *  else `name:<name>`. */
export function groupChatRoomKey(name: string, room: { roomId?: null | string }): string {
  return typeof room?.roomId === 'string' && room.roomId ? `id:${room.roomId}` : `name:${String(name)}`
}

/** Stable message identity for concurrent log union. Synthetic `legacy-N`
 *  ids are position-derived and not stable across a gateway round-trip, so
 *  the whole family collapses to one bucket. */
export function groupChatSyncEntryKey(entry: GroupMessage): string {
  if (entry?.id) return `id:${String(entry.id)}`

  return JSON.stringify([
    Number(entry?.at || 0),
    String(entry?.from?.kind || ''),
    String(entry?.from?.name || ''),
    String(entry?.from?.source || ''),
    String(entry?.thread || 'legacy').replace(/^legacy-\d+$/, 'legacy'),
    String(entry?.text || '')
  ])
}

/** Members dedupe on durable identity — the same (connectionId, name) pair
 *  botRosterKey seats them by everywhere else. Display strings (label,
 *  handle) are re-derived per machine and must not key membership. */
export function groupChatSyncMemberKey(member: GroupMember): string {
  return `${member?.connectionId || 'legacy'}::${member?.name || 'default'}`
}

/** Lift any historical projection shape (v1 wall-clock, v2 name-keyed) to
 *  the v3 room-key shape so one merge path serves mixed-version fleets. */
export function normalizeGroupChatSyncSnapshot(snapshot: GroupChatSyncSnapshot | null | undefined): GroupChatSyncSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    return { version: 3, rooms: {}, deleted: {} }
  }

  if (Number(snapshot.version || 0) >= 3) {
    return {
      version: 3,
      updatedAt: Number(snapshot.updatedAt || 0),
      rooms: snapshot.rooms && typeof snapshot.rooms === 'object' ? snapshot.rooms : {},
      deleted: snapshot.deleted && typeof snapshot.deleted === 'object' ? snapshot.deleted : {}
    }
  }

  const rooms: Record<string, GroupChatSyncRoom> = {}

  for (const [name, room] of Object.entries(snapshot.rooms || {})) {
    if (!room || !Array.isArray(room.log)) continue
    rooms[`name:${name}`] = { ...room, name }
  }

  const deleted: Record<string, number> = {}

  for (const [name, at] of Object.entries(snapshot.deleted || {})) {
    // v1 tombstones carried wall-clock ms, not gateway revisions — they must
    // not outrank real revisions.
    deleted[`name:${name}`] = Number(snapshot.version || 0) >= 2 ? Math.max(0, Number(at || 0)) : 0
  }

  return { version: 3, updatedAt: Number(snapshot.updatedAt || 0), rooms, deleted }
}

/** Threadless entries get synthetic threads: a new one after a USER entry
 *  following a 15-minute lull. */
export function assignLegacyThreads(log: GroupMessage[]): GroupMessage[] {
  let current: null | string = null
  let n = 0

  return (log || []).map((entry, i) => {
    if (entry?.thread) {
      current = null
      return entry
    }

    const prev = log[i - 1]
    const lull = !prev || (entry.at || 0) - (prev.at || 0) > GROUP_THREAD_GAP_MS

    if (!current || (entry.from?.kind === 'user' && lull)) {
      current = `legacy-${n++}`
    }

    return { ...entry, thread: current }
  })
}

/** Compact, display-oriented copy of the local room log for gateway clients.
 *  The live orchestration state stays in the local store; this bounded mirror
 *  rides the default profile's ui_meta so every client sees the same messages.
 *  Newest rooms/messages win when the size cap is reached. */
export function groupChatSyncSnapshot(
  all: Record<string, GroupChatRoom> = $groupChats.get(),
  deleted: Record<string, number> = {}
): GroupChatSyncSnapshot {
  const ranked = Object.entries(all || {})
    // Empty runtime tombstones stop an in-flight room after disband; they
    // are not real rooms and must never reappear on other clients.
    .filter(([, room]) => room && Array.isArray(room.log) && room.log.length > 0)
    .sort(([, left], [, right]) => {
      const leftAt = Number(left.log[left.log.length - 1]?.at || 0)
      const rightAt = Number(right.log[right.log.length - 1]?.at || 0)
      return rightAt - leftAt
    })

  const rooms: Record<string, GroupChatSyncRoom> = {}

  const boundedDeleted = Object.fromEntries(
    Object.entries(deleted)
      .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0))
      .slice(0, 64)
  )

  const envelope: GroupChatSyncSnapshot = {
    version: 3,
    updatedAt: Date.now(),
    rooms,
    ...(Object.keys(boundedDeleted).length ? { deleted: boundedDeleted } : {})
  }

  for (const [name, room] of ranked) {
    const log: GroupMessage[] = room.log.slice(-GROUP_CHAT_SYNC_MESSAGES).map(entry => ({
      ...(entry?.id ? { id: String(entry.id).slice(0, 160) } : {}),
      from: {
        kind: entry?.from?.kind === 'member' ? 'member' : 'user',
        name: String(entry?.from?.name || (entry?.from?.kind === 'member' ? 'Bot' : 'You')).slice(0, 128),
        ...(entry?.from?.source ? { source: String(entry.from.source).slice(0, 128) } : {})
      },
      text: String(entry?.text || '').slice(0, GROUP_CHAT_SYNC_TEXT_CHARS),
      at: Number(entry?.at || 0),
      ...(entry?.thread ? { thread: String(entry.thread).slice(0, 128) } : {})
    }))

    const compact: GroupChatSyncRoom = {
      name: String(name).slice(0, 64),
      ...(typeof room?.roomId === 'string' && room.roomId ? { roomId: String(room.roomId).slice(0, 128) } : {}),
      log,
      revision: Math.max(0, Number(room?.syncRevision ?? 0)),
      members: (Array.isArray(room.members) ? room.members : []).slice(0, 6).map(member => ({
        name: String(member?.name || '').slice(0, 128),
        ...(member?.handle ? { handle: String(member.handle).slice(0, 128) } : {}),
        ...(member?.connectionId ? { connectionId: String(member.connectionId).slice(0, 128) } : {}),
        ...(member?.connectionKind ? { connectionKind: String(member.connectionKind).slice(0, 64) } : {}),
        ...(member?.connectionLabel ? { connectionLabel: String(member.connectionLabel).slice(0, 128) } : {}),
        ...(member?.sourceScoped ? { sourceScoped: true } : {})
      })),
      ...(typeof room?.image === 'string' && room.image.length <= GROUP_CHAT_SYNC_IMAGE_CHARS ? { image: room.image } : {})
    }

    const key = groupChatRoomKey(name, room)
    rooms[key] = compact

    while (compact.log.length > 1 && groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      compact.log.shift()
    }

    if (compact.image && groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      delete compact.image
    }

    if (groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      delete rooms[key]
    }
  }

  return envelope
}

/** Assemble + size-bound a v3 envelope from already-compacted rooms. */
function groupChatSyncEnvelope(rooms: Record<string, GroupChatSyncRoom>, deleted: Record<string, number> = {}): GroupChatSyncSnapshot {
  const boundedDeleted = Object.fromEntries(
    Object.entries(deleted)
      .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0))
      .slice(0, 64)
  )

  const envelope: GroupChatSyncSnapshot = {
    version: 3,
    updatedAt: Date.now(),
    rooms,
    ...(Object.keys(boundedDeleted).length ? { deleted: boundedDeleted } : {})
  }

  const ranked = Object.entries(rooms).sort(([, left], [, right]) => {
    const leftAt = Number(left?.log?.[left.log.length - 1]?.at || 0)
    const rightAt = Number(right?.log?.[right.log.length - 1]?.at || 0)
    return leftAt - rightAt
  })

  for (const [key, room] of ranked) {
    while ((room.log?.length || 0) > 1 && groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      room.log.shift()
    }

    if (room.image && groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      delete room.image
    }

    if (groupChatGatewayJsonSize(envelope) > GROUP_CHAT_SYNC_MAX_BYTES) {
      delete rooms[key]
    }
  }

  return envelope
}

/** Merge two bounded projections without treating an absent room/message as
 *  deletion. Rooms are identified by durable room keys, so a rename is a
 *  same-key field update and a disband tombstone follows the room itself.
 *  Gateway revisions order identity/membership/picture and tombstones;
 *  stable message ids make concurrent log union idempotent.
 *  `changedRooms`/`deletedRooms` accept display names or room keys. */
export function mergeGroupChatSyncSnapshots(
  remote: GroupChatSyncSnapshot | null | undefined,
  local: GroupChatSyncSnapshot | null | undefined,
  {
    changedRooms = [],
    deletedRooms = [],
    writeRevision = 0
  }: { changedRooms?: string[]; deletedRooms?: string[]; writeRevision?: number } = {}
): GroupChatSyncSnapshot {
  const remoteNorm = normalizeGroupChatSyncSnapshot(remote)
  const localNorm = normalizeGroupChatSyncSnapshot(local)

  const keysFor = (label: string, norm: GroupChatSyncSnapshot) => {
    const keys = new Set<string>()

    for (const [key, room] of Object.entries(norm.rooms || {})) {
      if (key === label || String(room?.name || '') === label || key === `name:${label}`) {
        keys.add(key)
      }
    }

    if (String(label).startsWith('id:') || String(label).startsWith('name:')) {
      keys.add(label)
    } else if (!keys.size) {
      keys.add(`name:${label}`)
    }

    return keys
  }

  const changed = new Set<string>()

  for (const label of changedRooms) {
    for (const key of keysFor(label, localNorm)) {
      changed.add(key)
    }
  }

  const deleted: Record<string, number> = {}

  for (const source of [remoteNorm, localNorm]) {
    for (const [key, at] of Object.entries(source.deleted || {})) {
      deleted[key] = Math.max(Number(deleted[key] || 0), Math.max(0, Number(at || 0)))
    }
  }

  for (const label of deletedRooms) {
    for (const key of new Set([...keysFor(label, remoteNorm), ...keysFor(label, localNorm)])) {
      // Rename passes changedRooms:[newName] + deletedRooms:[oldName]; a key
      // being written this cycle is a rename target, not a disband.
      if (changed.has(key)) continue
      deleted[key] = Math.max(Number(deleted[key] || 0), Number(writeRevision || 0))
    }
  }

  const rooms: Record<string, GroupChatSyncRoom> = {}
  const roomKeys = new Set([...Object.keys(remoteNorm.rooms || {}), ...Object.keys(localNorm.rooms || {})])

  for (const key of roomKeys) {
    const remoteRoom = remoteNorm.rooms?.[key]
    const localRoom = localNorm.rooms?.[key]

    if ((!remoteRoom || !Array.isArray(remoteRoom.log)) && (!localRoom || !Array.isArray(localRoom.log))) {
      continue
    }

    const remoteRevision = Math.max(0, Number(remoteRoom?.revision || 0))
    const localRevision = changed.has(key)
      ? Math.max(0, Number(writeRevision || 0))
      : Math.max(0, Number(localRoom?.revision || 0))

    const entries = new Map<string, GroupMessage>()

    for (const entry of [...(remoteRoom?.log || []), ...(localRoom?.log || [])]) {
      entries.set(groupChatSyncEntryKey(entry), entry)
    }

    // Identity fields (display name, membership, picture) follow the higher
    // revision; a tie unions members and prefers the local writer's fields.
    let identity: GroupChatSyncRoom | undefined
    let members: GroupMember[]
    let image: null | string | undefined

    if (localRevision > remoteRevision) {
      identity = localRoom
      members = [...(localRoom?.members || [])]
      image = localRoom?.image
    } else if (remoteRevision > localRevision) {
      identity = remoteRoom
      members = [...(remoteRoom?.members || [])]
      image = remoteRoom?.image
    } else {
      identity = localRoom || remoteRoom
      const byId = new Map<string, GroupMember>()

      for (const member of [...(remoteRoom?.members || []), ...(localRoom?.members || [])]) {
        byId.set(groupChatSyncMemberKey(member), member)
      }

      members = [...byId.values()]
      image = Object.prototype.hasOwnProperty.call(localRoom || {}, 'image') ? localRoom.image : remoteRoom?.image
    }

    rooms[key] = {
      name: String(identity?.name || (key.startsWith('name:') ? key.slice(5) : '')),
      ...(identity?.roomId || (key.startsWith('id:') ? key.slice(3) : '')
        ? { roomId: identity?.roomId || key.slice(3) }
        : {}),
      log: [...entries.values()].sort((left, right) => {
        const byTime = Number(left?.at || 0) - Number(right?.at || 0)
        return byTime || groupChatSyncEntryKey(left).localeCompare(groupChatSyncEntryKey(right))
      }),
      members,
      revision: Math.max(remoteRevision, localRevision),
      ...(typeof image === 'string' && image ? { image } : {})
    }
  }

  for (const [key, deletedRevision] of Object.entries(deleted)) {
    if (key.startsWith('id:')) {
      // Tombstones for id-keyed rooms are FINAL: the roomId is minted once
      // and never reused, so a resurrect-by-revision race is structurally
      // impossible.
      delete rooms[key]
    } else if (Number(deletedRevision || 0) >= Number(rooms[key]?.revision || 0)) {
      delete rooms[key]
    } else {
      delete deleted[key]
    }
  }

  return groupChatSyncEnvelope(rooms, deleted)
}

/** Merge the gateway's bounded display projection into the local room store
 *  without discarding local session/watermark/runtime fields. Missing remote
 *  rooms/messages are not deletions; only explicit tombstones remove a room. */
export function mergeRemoteGroupChatSnapshotIntoRooms(
  remote: GroupChatSyncSnapshot | null | undefined,
  current: Record<string, GroupChatRoom> = $groupChats.get(),
  { deletedRooms = [], preserveRooms = [] }: { deletedRooms?: string[]; preserveRooms?: string[] } = {}
): Record<string, GroupChatRoom> {
  const remoteNorm = normalizeGroupChatSyncSnapshot(remote)
  const rooms: Record<string, GroupChatRoom> = { ...(current || {}) }

  const preserved = new Set(preserveRooms)
  const locallyDeleted = new Set(deletedRooms)

  // Local rooms indexed by durable identity so an id-keyed projection room
  // finds its local twin even when the display name changed remotely.
  const localByRoomId = new Map<string, string>()

  for (const [name, room] of Object.entries(rooms)) {
    if (typeof room?.roomId === 'string' && room.roomId) {
      localByRoomId.set(room.roomId, name)
    }
  }

  for (const [key, projected] of Object.entries(remoteNorm.rooms || {})) {
    if (!projected || !Array.isArray(projected.log)) continue

    const projectedRoomId = projected.roomId || (key.startsWith('id:') ? key.slice(3) : null)

    const localName =
      projectedRoomId && localByRoomId.has(projectedRoomId)
        ? localByRoomId.get(projectedRoomId)!
        : projected.name && rooms[projected.name]
          ? projected.name
          : null

    const displayName = String(projected.name || localName || (key.startsWith('name:') ? key.slice(5) : key))

    if (locallyDeleted.has(displayName) || (localName && locallyDeleted.has(localName))) {
      // Mid-rename guard: the remote copy may still be under the OLD display
      // name while the local record was already re-keyed.
      if (localName && localName !== displayName && !locallyDeleted.has(localName)) {
        continue
      }

      delete rooms[displayName]
      if (localName) delete rooms[localName]
      continue
    }

    const existing = (localName ? rooms[localName] : rooms[displayName]) || {
      name: displayName,
      log: [],
      watermarks: {},
      epoch: 0,
      running: false
    }
    const remoteRevision = Math.max(0, Number(projected.revision || 0))
    const localRevision = Math.max(0, Number(existing.syncRevision || 0))

    const entries = new Map<string, GroupMessage>(
      (Array.isArray(existing.log) ? existing.log : []).map(entry => [groupChatSyncEntryKey(entry), entry])
    )

    const members = new Map<string, GroupMember>(
      (Array.isArray(existing.members) ? existing.members : []).map(member => [groupChatSyncMemberKey(member), member])
    )

    for (const entry of projected.log) {
      const entryKey = groupChatSyncEntryKey(entry)

      // The projection is COMPACT (truncated text, no images). When the same
      // entry exists locally, the local rich copy is authoritative — merging
      // the compact twin over it would strip attachments and retrigger
      // watermark deltas (phantom rounds).
      if (!entries.has(entryKey)) {
        entries.set(entryKey, entry)
      }
    }

    const isPreserved = preserved.has(displayName) || (localName && preserved.has(localName))

    if (!isPreserved) {
      if (remoteRevision > localRevision) {
        members.clear()
      }

      for (const member of Array.isArray(projected.members) ? projected.members : []) {
        members.set(groupChatSyncMemberKey(member), { ...member, sourceScoped: member.sourceScoped })
      }
    }

    const log = assignLegacyThreads(
      [...entries.values()].sort((left, right) => {
        const byTime = Number(left?.at || 0) - Number(right?.at || 0)
        return byTime || groupChatSyncEntryKey(left).localeCompare(groupChatSyncEntryKey(right))
      })
    )

    const bounded = trimLocalLog(log, existing.watermarks || {})

    // A remote rename with a higher revision moves the local record to the
    // new display name; local views keyed by the old name follow on the
    // next repaint.
    const targetName = !isPreserved && remoteRevision > localRevision ? displayName : localName || displayName

    if (localName && targetName !== localName) {
      delete rooms[localName]
    }

    rooms[targetName] = {
      ...existing,
      log: bounded.log,
      watermarks: bounded.watermarks,
      sessions: existing.sessions && typeof existing.sessions === 'object' ? existing.sessions : {},
      stranded: existing.stranded && typeof existing.stranded === 'object' ? existing.stranded : {},
      members: [...members.values()],
      ...(projectedRoomId || existing.roomId ? { roomId: existing.roomId || projectedRoomId } : {}),
      image:
        isPreserved
          ? existing.image || null
          : remoteRevision >= localRevision && Object.prototype.hasOwnProperty.call(projected, 'image')
            ? projected.image || null
            : existing.image || null,
      syncRevision: isPreserved ? localRevision : Math.max(remoteRevision, localRevision),
      epoch: Number(existing.epoch || 0),
      running: Boolean(existing.running)
    }
  }

  for (const [key, deletedAt] of Object.entries(remoteNorm.deleted || {})) {
    const deletedRoomId = key.startsWith('id:') ? key.slice(3) : null

    const targetName =
      deletedRoomId && localByRoomId.has(deletedRoomId)
        ? localByRoomId.get(deletedRoomId)!
        : key.startsWith('name:')
          ? key.slice(5)
          : null

    if (!targetName || preserved.has(targetName)) continue

    if (deletedRoomId) {
      // Id tombstones are final — the id is never reused.
      delete rooms[targetName]
    } else {
      const deletedRevision = Math.max(0, Number(deletedAt || 0))
      if (deletedRevision >= Number(rooms[targetName]?.syncRevision || 0)) {
        delete rooms[targetName]
      }
    }
  }

  for (const name of locallyDeleted) {
    delete rooms[name]
  }

  return rooms
}

function trimLocalLog(log: GroupMessage[], watermarks: Record<string, number>, limit = 96) {
  if (log.length <= limit) return { log, watermarks }
  const drop = log.length - limit
  const trimmed: Record<string, number> = {}
  for (const [name, index] of Object.entries(watermarks || {})) {
    trimmed[name] = Math.max(0, index - drop)
  }
  return { log: log.slice(drop), watermarks: trimmed }
}

// --- flush job (read-merge-CAS-write with read-back) -------------------------

interface SyncPending {
  allowEmpty: boolean
  changedRooms: string[]
  deletedRooms: string[]
}

let disposed = false
let inFlight = false
let pending: SyncPending | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
const FLUSH_DEBOUNCE_MS = 350
const MAX_RETRIES = 8

function mergePending(existing: SyncPending | null, incoming: SyncPending): SyncPending {
  if (!existing) return incoming
  return {
    allowEmpty: existing.allowEmpty || incoming.allowEmpty,
    changedRooms: [...new Set([...existing.changedRooms, ...incoming.changedRooms])],
    deletedRooms: [...new Set([...existing.deletedRooms, ...incoming.deletedRooms])]
  }
}

function syncPayloadEqual(left: GroupChatSyncSnapshot | null | undefined, right: GroupChatSyncSnapshot | null | undefined): boolean {
  return (
    JSON.stringify(left?.rooms || {}) === JSON.stringify(right?.rooms || {}) &&
    JSON.stringify(left?.deleted || {}) === JSON.stringify(right?.deleted || {})
  )
}

async function readRemoteSnapshot(): Promise<{ snapshot: GroupChatSyncSnapshot | null; revision: number; supportsCas: boolean }> {
  const result = (await groupEngineRequest('profiles.list', { include_sessions: false })) as {
    profiles?: Array<Record<string, unknown>>
  }
  const profile = (Array.isArray(result?.profiles) ? result.profiles : []).find(row => row?.name === 'default')
  const uiMeta = (profile?.ui_meta ?? {}) as Record<string, unknown>
  const snapshot = uiMeta[GROUP_CHAT_SYNC_META_KEY] as GroupChatSyncSnapshot | undefined
  const supportsCas = Boolean(profile && Object.prototype.hasOwnProperty.call(profile, 'ui_meta_revisions'))
  const revisions = (profile?.ui_meta_revisions ?? {}) as Record<string, unknown>

  return {
    snapshot:
      snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as GroupChatSyncSnapshot) : null,
    revision: Math.max(0, Number(revisions[GROUP_CHAT_SYNC_META_KEY] || 0)),
    supportsCas
  }
}

/** Pull the shared room projection into this client before it publishes any
 *  local state — the receive half of the sync contract. */
export async function pullGroupChatState(): Promise<boolean> {
  const { snapshot } = await readRemoteSnapshot()
  if (!snapshot) return false

  const merged = mergeRemoteGroupChatSnapshotIntoRooms(snapshot, $groupChats.get(), {
    preserveRooms: pending?.changedRooms || [],
    deletedRooms: pending?.deletedRooms || []
  })
  replaceGroupChats(merged)
  return true
}

async function flushGroupChatSync(): Promise<void> {
  if (disposed || inFlight || !pending) return

  const job = pending
  pending = null
  inFlight = true

  try {
    const remoteState = await readRemoteSnapshot()
    const local = groupChatSyncSnapshot($groupChats.get())
    const writeRevision = remoteState.revision + 1

    const snapshot = mergeGroupChatSyncSnapshots(remoteState.snapshot, local, {
      changedRooms: job.changedRooms,
      deletedRooms: job.deletedRooms,
      writeRevision
    })

    // Reconnect/startup reconciliation often discovers the gateway already
    // holds the exact merged projection. Avoid advancing a revision merely
    // because a view reopened.
    if (
      !(job.changedRooms || []).length &&
      !(job.deletedRooms || []).length &&
      syncPayloadEqual(snapshot, remoteState.snapshot)
    ) {
      if (remoteState.snapshot) {
        await pullGroupChatState()
      }
      retryCount = 0
      return
    }

    const configureParams: {
      name: string
      ui_meta: Record<string, GroupChatSyncSnapshot>
      ui_meta_expected_revisions?: Record<string, number>
    } = {
      name: 'default',
      ui_meta: { [GROUP_CHAT_SYNC_META_KEY]: snapshot }
    }

    if (remoteState.supportsCas) {
      configureParams.ui_meta_expected_revisions = { [GROUP_CHAT_SYNC_META_KEY]: remoteState.revision }
    }

    const result = (await groupEngineRequest('profiles.configure', configureParams)) as {
      applied?: { ui_meta?: boolean; ui_meta_revisions?: Record<string, number> }
    }

    if (result?.applied?.ui_meta !== true) {
      throw new Error('Gateway rejected group chat ui_meta')
    }

    if (
      remoteState.supportsCas &&
      Number(result?.applied?.ui_meta_revisions?.[GROUP_CHAT_SYNC_META_KEY] || 0) !== writeRevision
    ) {
      throw new Error('Gateway did not advance group chat ui_meta revision')
    }

    // Read-back: a gateway that accepted the write but did not persist it
    // must not be trusted as the merged state's source of truth.
    const confirmedState = await readRemoteSnapshot()

    if (remoteState.supportsCas && confirmedState.revision < writeRevision) {
      throw new Error('Group chat ui_meta revision missing after read-back')
    }

    if (confirmedState.snapshot) {
      const merged = mergeRemoteGroupChatSnapshotIntoRooms(confirmedState.snapshot, $groupChats.get(), {
        preserveRooms: job.changedRooms || [],
        deletedRooms: job.deletedRooms || []
      })
      replaceGroupChats(merged)
    }

    retryCount = 0
  } catch {
    if (!disposed) {
      retryCount += 1

      if (retryCount > MAX_RETRIES) {
        retryCount = 0
        return
      }

      pending = mergePending(pending, job)
      if (!retryTimer) {
        // Backoff ladder: 1s * 2^n, capped at 30s.
        const delay = Math.min(30000, 1000 * 2 ** Math.min(retryCount - 1, 5))
        retryTimer = setTimeout(() => {
          retryTimer = null
          void flushGroupChatSync()
        }, delay)
      }
    }
  } finally {
    inFlight = false
    if (pending && !retryTimer && !disposed) {
      void flushGroupChatSync()
    }
  }
}

/** Debounced, pull-merge-write mirror publish. */
export function scheduleGroupChatSync({
  allowEmpty = false,
  changedRooms = [],
  deletedRooms = []
}: { allowEmpty?: boolean; changedRooms?: string[]; deletedRooms?: string[] } = {}): void {
  if (typeof setTimeout !== 'function') return

  const snapshot = groupChatSyncSnapshot($groupChats.get())

  // A freshly installed client has no local room cache. Publishing that
  // empty state would erase a valid mirror produced elsewhere. Only an
  // explicit final-room disband may clear the projection.
  if (Object.keys(snapshot.rooms).length === 0 && !allowEmpty) {
    return
  }

  if (debounceTimer !== null) clearTimeout(debounceTimer)

  pending = mergePending(pending, { allowEmpty, changedRooms, deletedRooms })

  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void flushGroupChatSync()
  }, FLUSH_DEBOUNCE_MS)
}

/** Tear down timers (scope teardown / profile switch). */
export function stopGroupChatSync(): void {
  disposed = true
  pending = null
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  retryCount = 0
}

/** Reactivate after a teardown (new gateway scope). */
export function startGroupChatSync(): void {
  disposed = false
}

/** A gateway swap invalidates any in-flight room drive: bump every room's
 *  epoch so running loops bail at their next member boundary. */
export function handleGatewayTransition(): void {
  const rooms = { ...$groupChats.get() }
  for (const name of Object.keys(rooms)) {
    rooms[name] = { ...rooms[name], epoch: (rooms[name].epoch || 0) + 1, running: false }
  }
  $groupChats.set(rooms)
}