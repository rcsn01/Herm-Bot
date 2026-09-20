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

import { groupMemberKey, groupRoomKey, type GroupEngineRequest, type GroupMember, type GroupMessage } from './group-model'
import { $groupChats, rekeyRoomCoordination, renameRoomState, replaceGroupChats, type GroupChatRoom } from './group-store'

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

export interface GroupMirrorRemoteState {
  snapshot: GroupChatSyncSnapshot | null
  revision: number
  supportsCas: boolean
}

export interface GroupMirrorWriteResult {
  applied: boolean
  revision?: number
}

export interface GroupMirrorGateway {
  read(signal: AbortSignal): Promise<GroupMirrorRemoteState>
  write(
    snapshot: GroupChatSyncSnapshot,
    expectedRevision: number | undefined,
    signal: AbortSignal
  ): Promise<GroupMirrorWriteResult>
}

export interface GroupMirrorSchedule {
  changedRooms?: string[]
}

export interface GroupMirror {
  pull(): Promise<boolean>
  schedule(options?: GroupMirrorSchedule): void
  stop(): void
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
      name: String(room.name).slice(0, 64),
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

    // The envelope key derives from the room row: keying by the map entry
    // would double-prefix name-keyed rows, and compact.name must stay the
    // display name even under a durable-keyed map.
    const key = groupRoomKey(room.name, room)
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
        byId.set(groupMemberKey(member), member)
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

  for (const [key, room] of Object.entries(rooms)) {
    if (typeof room?.roomId === 'string' && room.roomId) {
      localByRoomId.set(room.roomId, key)
    }
  }

  for (const [key, projected] of Object.entries(remoteNorm.rooms || {})) {
    if (!projected || !Array.isArray(projected.log)) continue

    const projectedRoomId = projected.roomId || (key.startsWith('id:') ? key.slice(3) : null)

    // Twin resolution, in order: the durable roomId, then the envelope key
    // itself (the local map is durable-keyed, so a name-keyed rename that
    // rides the old key resolves here — today's fallback never tried it and
    // forked the room), then the projected display name.
    const localKey =
      projectedRoomId && localByRoomId.has(projectedRoomId)
        ? localByRoomId.get(projectedRoomId)!
        : rooms[key]
          ? key
          : projected.name && rooms[`name:${projected.name}`]
            ? `name:${projected.name}`
            : null

    const displayName = String(
      projected.name || (localKey ? rooms[localKey].name : '') || (key.startsWith('name:') ? key.slice(5) : key)
    )

    if (locallyDeleted.has(key) || locallyDeleted.has(displayName) || (localKey !== null && locallyDeleted.has(localKey))) {
      // Mid-rename guard: the remote copy may still be under the OLD durable
      // key while the local record was already re-keyed.
      if (localKey !== null && localKey !== key && !locallyDeleted.has(localKey)) {
        continue
      }

      delete rooms[key]
      if (localKey !== null) delete rooms[localKey]
      continue
    }

    const existing: GroupChatRoom = (localKey !== null ? rooms[localKey] : undefined) || {
      name: displayName,
      log: [],
      members: [],
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
      (Array.isArray(existing.members) ? existing.members : []).map(member => [groupMemberKey(member), member])
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

    const isPreserved = preserved.has(key) || preserved.has(displayName) || (localKey !== null && preserved.has(localKey))

    if (!isPreserved) {
      if (remoteRevision > localRevision) {
        members.clear()
      }

      for (const member of Array.isArray(projected.members) ? projected.members : []) {
        members.set(groupMemberKey(member), { ...member, sourceScoped: member.sourceScoped })
      }
    }

    const log = assignLegacyThreads(
      [...entries.values()].sort((left, right) => {
        const byTime = Number(left?.at || 0) - Number(right?.at || 0)
        return byTime || groupChatSyncEntryKey(left).localeCompare(groupChatSyncEntryKey(right))
      })
    )

    const bounded = trimLocalLog(log, existing.watermarks || {})

    // The output row is keyed by its CANONICAL durable key, which makes the
    // rename branch two-shape: for an id-keyed room the canonical key equals
    // the twin's map key, so `room.name` updates in place and nothing keyed
    // by identity moves. For a name-keyed room whose envelope still carries
    // the old key, the canonical key differs from the twin's — the map entry
    // moves and renameRoomState sweeps the feed atoms. When no twin resolves
    // (the desktop re-keyed its own snapshot first: tombstone for the old key
    // plus the room under the new key), the row recreates from the projection
    // exactly as today and the atoms strand — no tombstone/creation pairing
    // is attempted, because a disband plus an unrelated create in one
    // envelope would mis-sweep the atoms onto the wrong room.
    const outputRoomId = existing.roomId || projectedRoomId || null
    const outputName = !isPreserved && remoteRevision > localRevision ? displayName : existing.name || displayName
    const targetKey = groupRoomKey(outputName, { roomId: outputRoomId })

    if (localKey !== null && targetKey !== localKey) {
      renameRoomState(localKey, targetKey)
      delete rooms[localKey]
    }

    rooms[targetKey] = rekeyRoomCoordination({
      ...existing,
      name: outputName,
      log: bounded.log,
      watermarks: bounded.watermarks,
      sessions: existing.sessions && typeof existing.sessions === 'object' ? existing.sessions : {},
      stranded: existing.stranded && typeof existing.stranded === 'object' ? existing.stranded : {},
      members: [...members.values()],
      ...(outputRoomId ? { roomId: outputRoomId } : {}),
      image:
        isPreserved
          ? existing.image || null
          : remoteRevision >= localRevision && Object.prototype.hasOwnProperty.call(projected, 'image')
            ? projected.image || null
            : existing.image || null,
      syncRevision: isPreserved ? localRevision : Math.max(remoteRevision, localRevision),
      epoch: Number(existing.epoch || 0),
      running: Boolean(existing.running)
    })
  }

  for (const [key, deletedAt] of Object.entries(remoteNorm.deleted || {})) {
    const deletedRoomId = key.startsWith('id:') ? key.slice(3) : null

    const targetKey =
      deletedRoomId && localByRoomId.has(deletedRoomId)
        ? localByRoomId.get(deletedRoomId)!
        : key.startsWith('name:')
          ? key
          : null

    if (!targetKey || preserved.has(targetKey)) continue

    if (deletedRoomId) {
      // Id tombstones are final — the id is never reused.
      delete rooms[targetKey]
    } else {
      const deletedRevision = Math.max(0, Number(deletedAt || 0))
      if (deletedRevision >= Number(rooms[targetKey]?.syncRevision || 0)) {
        delete rooms[targetKey]
      }
    }
  }

  for (const key of locallyDeleted) {
    delete rooms[key]
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

// --- semantic gateway adapter and mirror lifecycle --------------------------

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Map the route-shaped profile protocol to the semantic mirror gateway. */
export function createGroupMirrorGateway(transport: GroupEngineRequest): GroupMirrorGateway {
  return {
    async read(signal) {
      const raw = await transport('profiles.list', { include_sessions: false }, { signal })
      const result = isObjectRecord(raw) ? raw : null
      const profiles = Array.isArray(result?.profiles) ? result.profiles : []
      const profileValue = profiles.find(profile => isObjectRecord(profile) && profile.name === 'default')
      const profile = isObjectRecord(profileValue) ? profileValue : null
      const uiMeta = profile && isObjectRecord(profile.ui_meta) ? profile.ui_meta : null
      const rawSnapshot = uiMeta?.[GROUP_CHAT_SYNC_META_KEY]
      const snapshot = isObjectRecord(rawSnapshot) ? rawSnapshot as unknown as GroupChatSyncSnapshot : null
      const revisions = profile && isObjectRecord(profile.ui_meta_revisions) ? profile.ui_meta_revisions : null
      const revision = finiteNonNegativeNumber(revisions?.[GROUP_CHAT_SYNC_META_KEY]) ?? 0
      const supportsCas = Boolean(profile && Object.prototype.hasOwnProperty.call(profile, 'ui_meta_revisions'))

      return { snapshot, revision, supportsCas }
    },

    async write(snapshot, expectedRevision, signal) {
      const params: Record<string, unknown> = {
        name: 'default',
        ui_meta: { [GROUP_CHAT_SYNC_META_KEY]: snapshot }
      }
      if (expectedRevision !== undefined) {
        params.ui_meta_expected_revisions = { [GROUP_CHAT_SYNC_META_KEY]: expectedRevision }
      }

      const raw = await transport('profiles.configure', params, { signal })
      const result = isObjectRecord(raw) ? raw : null
      const applied = isObjectRecord(result?.applied) ? result.applied : null
      const revisions = applied && isObjectRecord(applied.ui_meta_revisions) ? applied.ui_meta_revisions : null
      const revision = finiteNonNegativeNumber(revisions?.[GROUP_CHAT_SYNC_META_KEY])

      return revision === undefined ? { applied: applied?.ui_meta === true } : {
        applied: applied?.ui_meta === true,
        revision
      }
    }
  }
}

interface SyncPending {
  changedRooms: string[]
}

const FLUSH_DEBOUNCE_MS = 350
const MAX_RETRIES = 8

function mergePending(existing: SyncPending | null, incoming: SyncPending): SyncPending {
  return {
    changedRooms: [...new Set([
      ...(existing?.changedRooms || []),
      ...incoming.changedRooms
    ])]
  }
}

function syncPayloadEqual(left: GroupChatSyncSnapshot | null | undefined, right: GroupChatSyncSnapshot | null | undefined): boolean {
  return (
    JSON.stringify(left?.rooms || {}) === JSON.stringify(right?.rooms || {}) &&
    JSON.stringify(left?.deleted || {}) === JSON.stringify(right?.deleted || {})
  )
}

export function createGroupMirror(gateway: GroupMirrorGateway): GroupMirror {
  let stopped = false
  let initialPullSettled = false
  let initialPulls = 0
  let inFlight = false
  let activeJob: SyncPending | null = null
  let pending: SyncPending | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryCount = 0
  // Pulls and flushes share one queue so an older remote read cannot publish
  // after a newer write's read-back.
  let operationQueue: Promise<void> | null = null
  const controller = new AbortController()

  const isCurrent = (signal: AbortSignal = controller.signal): boolean => !stopped && !signal.aborted

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = operationQueue
    const result = queued ? queued.then(operation) : operation()
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  const changedRoomsInFlight = (): string[] => [...new Set([
    ...(activeJob?.changedRooms || []),
    ...(pending?.changedRooms || [])
  ])]

  const flush = async (): Promise<void> => {
    if (stopped || !initialPullSettled || inFlight || retryTimer || !pending) return

    const job = pending
    pending = null
    activeJob = job
    inFlight = true
    const signal = controller.signal

    return enqueue(async () => {
      if (!isCurrent(signal)) return

      try {
        const remoteState = await gateway.read(signal)
        if (!isCurrent(signal)) return

        const local = groupChatSyncSnapshot($groupChats.get())
        const writeRevision = remoteState.revision + 1
        const snapshot = mergeGroupChatSyncSnapshots(remoteState.snapshot, local, {
          changedRooms: job.changedRooms,
          writeRevision
        })

        // Reconciliation can find the exact merged projection already stored at
        // the gateway. Do not advance a revision just because the view reopened.
        if (!job.changedRooms.length && syncPayloadEqual(snapshot, remoteState.snapshot)) {
          if (remoteState.snapshot) {
            // This flush already holds the operation queue; calling public pull()
            // here would enqueue behind itself.
            await runPull(false, signal)
            if (!isCurrent(signal)) return
          }
          retryCount = 0
          return
        }

        const result = await gateway.write(
          snapshot,
          remoteState.supportsCas ? remoteState.revision : undefined,
          signal
        )
        if (!isCurrent(signal)) return

        if (result.applied !== true) {
          throw new Error('Gateway rejected group chat ui_meta')
        }
        if (remoteState.supportsCas && result.revision !== writeRevision) {
          throw new Error('Gateway did not advance group chat ui_meta revision')
        }

        const confirmedState = await gateway.read(signal)
        if (!isCurrent(signal)) return
        if (remoteState.supportsCas && confirmedState.revision < writeRevision) {
          throw new Error('Group chat ui_meta revision missing after read-back')
        }

        if (confirmedState.snapshot) {
          const merged = mergeRemoteGroupChatSnapshotIntoRooms(
            confirmedState.snapshot,
            $groupChats.get(),
            { preserveRooms: changedRoomsInFlight() }
          )
          if (!isCurrent(signal)) return
          replaceGroupChats(merged)
        }

        retryCount = 0
      } catch {
        if (!isCurrent(signal)) return

        retryCount += 1
        if (retryCount > MAX_RETRIES) {
          retryCount = 0
          return
        }

        pending = mergePending(pending, job)
        if (!retryTimer && typeof setTimeout === 'function') {
          const delay = Math.min(30000, 1000 * 2 ** Math.min(retryCount - 1, 5))
          retryTimer = setTimeout(() => {
            retryTimer = null
            if (isCurrent(signal)) void flush()
          }, delay)
        }
      } finally {
        if (!isCurrent(signal)) return
        activeJob = null
        inFlight = false
        if (pending && !retryTimer) void flush()
      }
    })
  }

  const runPull = async (isInitialPull: boolean, signal: AbortSignal): Promise<boolean> => {
    if (!isCurrent(signal)) return false

    try {
      const remoteState = await gateway.read(signal)
      if (!isCurrent(signal) || !remoteState.snapshot) return false

      const merged = mergeRemoteGroupChatSnapshotIntoRooms(
        remoteState.snapshot,
        $groupChats.get(),
        { preserveRooms: changedRoomsInFlight() }
      )
      if (!isCurrent(signal)) return false
      replaceGroupChats(merged)
      return true
    } catch (error) {
      if (!isCurrent(signal)) return false
      throw error
    } finally {
      if (isInitialPull) {
        initialPulls -= 1
        if (initialPulls === 0) {
          initialPullSettled = true
          if (isCurrent(signal)) void flush()
        }
      }
    }
  }

  const pull = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false)

    const isInitialPull = !initialPullSettled
    if (isInitialPull) initialPulls += 1
    const signal = controller.signal
    const operation = enqueue(() => runPull(isInitialPull, signal))
    return operation
  }

  const schedule = (options: GroupMirrorSchedule = {}): void => {
    if (stopped || typeof setTimeout !== 'function') return

    const snapshot = groupChatSyncSnapshot($groupChats.get())
    if (Object.keys(snapshot.rooms).length === 0) return

    pending = mergePending(pending, { changedRooms: options.changedRooms || [] })
    if (!initialPullSettled) return

    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (isCurrent()) void flush()
    }, FLUSH_DEBOUNCE_MS)
  }

  const stop = (): void => {
    if (stopped) return
    stopped = true
    controller.abort()

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }

    pending = null
    activeJob = null
    retryCount = 0
    inFlight = false
  }

  return { pull, schedule, stop }
}
