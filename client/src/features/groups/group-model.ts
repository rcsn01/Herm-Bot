/**
 * Group chats with bots, as the gateway mirrors them for non-desktop
 * clients. Desktop Bot Mode owns the rooms in plugin storage and mirrors a
 * bounded, display-oriented copy under the DEFAULT profile's
 * `ui_meta['hermes-bots-groups']` key on every profiles.list row
 * (apps/desktop/src/plugins/hermes-bots/group-chat.ts, groupChatSyncSnapshot:
 * "a bounded cross-client projection in the gateway, riding the default
 * profile's ui_meta ... so mobile can show the same messages"). Rooms carry
 * at most 16 log entries and 6 members; rooms with empty logs are runtime
 * tombstones that must never reappear, and the `deleted` map holds the keys
 * of disbanded rooms so a stale snapshot cannot resurrect them.
 */

export interface GroupMessageAuthor {
  kind: 'member' | 'user'
  name: string
  /** Connection label, present when the speaker lives on another machine. */
  source?: string
}

export interface GroupMessage {
  /** Milliseconds. */
  at: number
  from: GroupMessageAuthor
  id?: string
  text: string
  /** Messages predating threading carry the sentinel thread `'legacy'`. */
  thread?: string
}

export interface GroupMember {
  handle?: string
  name: string
  /** Source-qualified remote members (another machine's connection). */
  connectionId?: string
  connectionKind?: string
  connectionLabel?: string
  sourceScoped?: boolean
}

export interface GroupRoom {
  /** Stable identity: the snapshot record key (`id:<roomId>` or
   *  `name:<name>`), so a rename never forks the room. */
  key: string
  image?: string
  log: GroupMessage[]
  members: GroupMember[]
  name: string
  roomId?: string
}

const GROUP_KEY_RE = /^(?:id|name):(.+)$/

export function parseGroupSnapshot(value: unknown): GroupRoom[] {
  if (typeof value !== 'object' || value === null) return []
  const rooms = (value as { rooms?: unknown }).rooms
  if (typeof rooms !== 'object' || rooms === null) return []
  const deleted = (value as { deleted?: unknown }).deleted
  const tombstones = typeof deleted === 'object' && deleted !== null ? new Set(Object.keys(deleted)) : new Set<string>()

  const parsed: GroupRoom[] = []
  for (const [key, raw] of Object.entries(rooms as Record<string, unknown>)) {
    if (tombstones.has(key) || typeof raw !== 'object' || raw === null) continue
    const record = raw as Record<string, unknown>
    const log = Array.isArray(record.log) ? record.log : []
    // Empty runtime tombstones stop an in-flight room after a disband and
    // must never reappear (desktop groupChatSyncSnapshot filters the same way).
    if (log.length === 0) continue
    const fallbackName = GROUP_KEY_RE.exec(key)?.[1] ?? key
    const name = typeof record.name === 'string' && record.name ? record.name : fallbackName
    const room: GroupRoom = {
      key,
      log: log.map(coerceGroupMessage),
      members: (Array.isArray(record.members) ? record.members : []).flatMap(coerceGroupMember),
      name
    }
    if (typeof record.roomId === 'string' && record.roomId) room.roomId = record.roomId
    if (typeof record.image === 'string' && record.image) room.image = record.image
    parsed.push(room)
  }
  // The desktop ranks rooms by their newest message before publishing.
  return parsed.sort((left, right) => lastAt(right) - lastAt(left))
}

function lastAt(room: GroupRoom): number {
  return room.log[room.log.length - 1]?.at ?? 0
}

function coerceGroupMessage(raw: unknown): GroupMessage {
  const entry = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const from = typeof entry.from === 'object' && entry.from !== null ? entry.from as Record<string, unknown> : {}
  const kind = from.kind === 'member' ? 'member' : 'user'
  return {
    at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : Number(entry.at) || 0,
    from: {
      kind,
      name: typeof from.name === 'string' && from.name ? from.name : kind === 'member' ? 'Bot' : 'You',
      ...(typeof from.source === 'string' && from.source ? { source: from.source } : {})
    },
    ...(typeof entry.id === 'string' && entry.id ? { id: entry.id } : {}),
    text: typeof entry.text === 'string' ? entry.text : String(entry.text ?? ''),
    ...(typeof entry.thread === 'string' && entry.thread ? { thread: entry.thread } : {})
  }
}

function coerceGroupMember(raw: unknown): { handle?: string; name: string }[] {
  if (typeof raw !== 'object' || raw === null) return []
  const member = raw as Record<string, unknown>
  const name = typeof member.name === 'string' && member.name ? member.name : null
  if (!name) return []
  return [{
    name,
    ...(typeof member.handle === 'string' && member.handle ? { handle: member.handle } : {})
  }]
}

/**
 * Extract the group snapshot from a profiles.list response body. The desktop
 * mirrors rooms onto the DEFAULT profile's ui_meta only, so a gateway without
 * Bot Mode group state simply yields no rooms.
 */
export function groupRoomsFromRoster(response: unknown): GroupRoom[] {
  const rows = typeof response === 'object' && response !== null && Array.isArray((response as Record<string, unknown>).profiles)
    ? (response as { profiles: unknown[] }).profiles
    : []
  const defaultRow = rows.find(row => {
    if (typeof row !== 'object' || row === null) return false
    const record = row as Record<string, unknown>
    return record.is_default === true || record.name === 'default'
  })
  if (typeof defaultRow !== 'object' || defaultRow === null) return []
  const uiMeta = (defaultRow as Record<string, unknown>).ui_meta
  if (typeof uiMeta !== 'object' || uiMeta === null) return []
  return parseGroupSnapshot((uiMeta as Record<string, unknown>)['hermes-bots-groups'])
}