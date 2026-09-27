/** Local-only ownership policy for Group member plumbing sessions, stranded
 *  markers, and prompts. This module is deliberately pure: the Group store
 *  owns atoms and persistence, while callers provide the captured Gateway
 *  connection key explicitly. */

export type GroupStrandedMarker = number | { before: number; thread: string }

/** The persisted room fields that are scoped to one Gateway connection. */
export interface GroupSessionProvenance {
  /** Gateway connection that owns both member maps. */
  sessionConnectionKey?: null | string
  /** Durable member plumbing-session ids. */
  sessions?: Record<string, string>
  /** Late-reply markers for the same owned member sessions. */
  stranded?: Record<string, GroupStrandedMarker>
}

/** Required owner tag carried by every pending Group prompt card. */
export interface GroupPromptConnectionProvenance {
  /** Gateway connection that produced the pending member-session request. */
  connectionKey: string
}

/** A v4 provenance trio after all-or-nothing validation. */
export interface ValidGroupSessionProvenance {
  sessionConnectionKey: string
  sessions: Record<string, string>
  stranded: Record<string, GroupStrandedMarker>
}

/** Validate the persisted room fields as one atomic provenance value. Missing
 *  maps are empty; a malformed tag or either malformed map invalidates the
 *  whole trio. Opaque non-empty stored ids are intentionally preserved. */
export function normalizeGroupSessionProvenance(value: unknown): ValidGroupSessionProvenance | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const connectionKey = source.sessionConnectionKey
  if (typeof connectionKey !== 'string' || !connectionKey) return null

  const sessionEntries: Array<[string, string]> = []
  if (source.sessions !== undefined) {
    if (typeof source.sessions !== 'object' || source.sessions === null || Array.isArray(source.sessions)) return null
    for (const [memberKey, sessionId] of Object.entries(source.sessions)) {
      if (!memberKey || typeof sessionId !== 'string' || !sessionId) return null
      sessionEntries.push([memberKey, sessionId])
    }
  }

  const strandedEntries: Array<[string, GroupStrandedMarker]> = []
  if (source.stranded !== undefined) {
    if (typeof source.stranded !== 'object' || source.stranded === null || Array.isArray(source.stranded)) return null
    for (const [memberKey, marker] of Object.entries(source.stranded)) {
      if (!memberKey) return null
      if (typeof marker === 'number') {
        if (!Number.isFinite(marker) || marker < 0) return null
        strandedEntries.push([memberKey, marker])
        continue
      }
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
      const before = (marker as { before?: unknown }).before
      const thread = (marker as { thread?: unknown }).thread
      if (typeof before !== 'number' || !Number.isFinite(before) || before < 0) return null
      if (typeof thread !== 'string' || !thread) return null
      strandedEntries.push([memberKey, { before, thread }])
    }
  }

  return {
    sessionConnectionKey: connectionKey,
    sessions: Object.fromEntries(sessionEntries),
    stranded: Object.fromEntries(strandedEntries)
  }
}

/** Read one stored id only when its entire room provenance is valid and owned
 *  by the caller's captured connection key. */
export function groupSessionIdForConnection(
  value: unknown,
  connectionKey: string,
  memberKey: string
): string | undefined {
  if (!connectionKey || !memberKey) return undefined
  const provenance = normalizeGroupSessionProvenance(value)
  if (provenance?.sessionConnectionKey !== connectionKey) return undefined
  if (!Object.prototype.hasOwnProperty.call(provenance.sessions, memberKey)) return undefined
  return provenance.sessions[memberKey]
}

/** Read a stranded marker only when its complete room trio is valid and
 *  owned by the caller's captured connection key. */
export function groupStrandedMarkerForConnection(
  value: unknown,
  connectionKey: string,
  memberKey: string
): GroupStrandedMarker | undefined {
  if (!connectionKey || !memberKey) return undefined
  const provenance = normalizeGroupSessionProvenance(value)
  if (provenance?.sessionConnectionKey !== connectionKey) return undefined
  const source = value as { stranded?: unknown }
  if (!source.stranded || typeof source.stranded !== 'object' || Array.isArray(source.stranded)) return undefined
  if (!Object.prototype.hasOwnProperty.call(source.stranded, memberKey)) return undefined
  // Return the original marker object after validating it, preserving the
  // turn module's identity check against a replacement marker during awaits.
  return (source.stranded as Record<string, GroupStrandedMarker>)[memberKey]
}

/** Drop the room-owned trio while leaving shared room fields untouched. */
export function stripGroupSessionProvenance<T extends GroupSessionProvenance>(value: T): T {
  const { sessionConnectionKey: _tag, sessions: _sessions, stranded: _stranded, ...shared } = value
  return shared as T
}

function hasEntries(value: unknown): boolean {
  return Boolean(value && Object.keys(Object(value)).length)
}

/** Retain matching state, or atomically remove a foreign/untagged trio. Empty
 *  maps without a tag carry no session state and remain an identity no-op. */
export function retainGroupSessionProvenanceForConnection<T extends GroupSessionProvenance>(
  value: T,
  connectionKey: string
): T {
  const carriesSessionState =
    Boolean(value.sessionConnectionKey) || hasEntries(value.sessions) || hasEntries(value.stranded)
  if (value.sessionConnectionKey === connectionKey || !carriesSessionState) return value
  return stripGroupSessionProvenance(value)
}

interface GroupSessionMemberKey {
  connectionId?: unknown
  name?: unknown
}

function rekeyProvenanceMap<T>(
  source: Record<string, T>,
  members: readonly GroupSessionMemberKey[]
): { changed: boolean; map: Record<string, T> } {
  const next = new Map(Object.entries(source))
  let changed = false
  for (const member of members) {
    if (typeof member?.connectionId !== 'string' || !member.connectionId || typeof member.name !== 'string' || !member.name) continue
    const bareKey = member.name
    const qualifiedKey = `${member.connectionId}::${member.name}`
    if (next.has(qualifiedKey) || !next.has(bareKey)) continue
    next.set(qualifiedKey, next.get(bareKey)!)
    next.delete(bareKey)
    changed = true
  }
  return { changed, map: Object.fromEntries(next) }
}

/** Re-key only a valid local provenance trio as member rows gain connection
 *  ids. Invalid/untagged maps are not promoted into owned state. */
export function rekeyGroupSessionProvenance<T extends GroupSessionProvenance>(
  value: T,
  members: readonly GroupSessionMemberKey[]
): T {
  const provenance = normalizeGroupSessionProvenance(value)
  if (!provenance) return stripGroupSessionProvenance(value)
  const sessions = rekeyProvenanceMap(provenance.sessions, members)
  const stranded = rekeyProvenanceMap(provenance.stranded, members)
  if (!sessions.changed && !stranded.changed) return value
  return {
    ...value,
    sessionConnectionKey: provenance.sessionConnectionKey,
    sessions: sessions.map,
    stranded: stranded.map
  }
}

/** Record a successful resume/create. Existing member entries survive only
 *  when the room is already owned by this exact connection; changing owners
 *  discards both old maps before applying the optional durable id. */
export function acquireGroupSessionProvenance(
  value: unknown,
  connectionKey: string,
  memberKey: string,
  storedId?: unknown
): GroupSessionProvenance & { sessionConnectionKey: string } {
  const current = normalizeGroupSessionProvenance(value)
  const sameOwner = current?.sessionConnectionKey === connectionKey
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const next: GroupSessionProvenance & { sessionConnectionKey: string } = {
    sessionConnectionKey: connectionKey
  }

  if (current && sameOwner && source?.sessions !== undefined) next.sessions = current.sessions
  if (current && sameOwner && source?.stranded !== undefined) next.stranded = current.stranded
  if (memberKey && typeof storedId === 'string' && storedId) {
    const sessions = sameOwner && current ? current.sessions : {}
    next.sessions = Object.fromEntries([
      ...Object.entries(sessions).filter(([key]) => key !== memberKey),
      [memberKey, storedId]
    ])
  }
  return next
}

/** Add the producing connection to a pending card. */
export function stampGroupPromptConnection<P extends object>(prompt: P, connectionKey: string): P & { connectionKey: string } {
  return { ...prompt, connectionKey }
}

/** A card can be answered only by the exact non-empty connection that
 *  produced it. Untagged and malformed cards fail closed. */
export function groupPromptBelongsToConnection(value: unknown, connectionKey: string): boolean {
  if (!connectionKey || !value || typeof value !== 'object') return false
  return (value as { connectionKey?: unknown }).connectionKey === connectionKey
}

/** Retain same-connection prompt cards and preserve map identity when nothing
 *  needs to be removed, so the store can keep its no-notification behavior. */
export function retainGroupPromptsForConnection<T extends object>(
  prompts: Record<string, T>,
  connectionKey: string
): Record<string, T> {
  const retained: Array<[string, T]> = []
  let changed = false
  for (const [key, prompt] of Object.entries(prompts)) {
    if (groupPromptBelongsToConnection(prompt, connectionKey)) retained.push([key, prompt])
    else changed = true
  }
  return changed ? Object.fromEntries(retained) : prompts
}
