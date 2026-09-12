import type { GatewayApi } from '~/gateway/gateway-api'

/** One agent row on the main screen: a gateway profile plus its latest-conversation data when known. */
export interface AgentRosterEntry {
  avatar?: string
  displayName?: string
  isDefault: boolean
  name: string
  preview?: string
  sessionId?: string
  startedAt?: number
  title?: string
}

/**
 * Normalize a last-active stamp into epoch seconds. Gateways report either
 * epoch milliseconds, epoch seconds, or an ISO timestamp depending on version.
 */
function toSeconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value)
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000)
  }
  return undefined
}

/** Accept one wire item from profiles.list; unusable entries become null. */
export function normalizeAgentEntry(item: unknown): AgentRosterEntry | null {
  if (typeof item === 'string') return { isDefault: item === 'default', name: item }
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const name = typeof record.name === 'string' && record.name
    ? record.name
    : typeof record.title === 'string' && record.title ? record.title : null
  if (!name) return null
  return {
    avatar: typeof record.avatar === 'string' && /^(data:image\/|https?:\/\/)/i.test(record.avatar) ? record.avatar : undefined,
    displayName: typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name.trim()
      : undefined,
    isDefault: record.is_default === true || (record.is_default === undefined && name === 'default'),
    name,
    preview: typeof record.preview === 'string' && record.preview ? record.preview : undefined,
    sessionId: typeof record.session_id === 'string' && record.session_id
      ? record.session_id
      : typeof record.canonical_session_id === 'string' ? record.canonical_session_id : undefined,
    startedAt: toSeconds(record.last_active ?? record.started_at),
    title: typeof record.title === 'string' && record.title ? record.title : undefined
  }
}

/** Parse a profiles.list response body: a bare array or a { profiles: [...] } wrapper. */
export function parseAgentRoster(response: unknown): AgentRosterEntry[] {
  const items = Array.isArray(response)
    ? response
    : typeof response === 'object' && response !== null && Array.isArray((response as Record<string, unknown>).profiles)
      ? (response as { profiles: unknown[] }).profiles
      : []
  return items.map(normalizeAgentEntry).filter((entry): entry is AgentRosterEntry => entry !== null)
}

/**
 * Merge gateway-level roster enrichment into the profile list from
 * /api/status. Status order wins so rows stay stable; enrichment overlays by
 * name; profiles only known to profiles.list are appended at the end.
 */
export function mergeAgentRoster(
  statusProfiles: ReadonlyArray<{ is_default?: boolean; name: string } | string> | undefined,
  entries: readonly AgentRosterEntry[] | undefined
): AgentRosterEntry[] {
  const enriched = new Map((entries ?? []).map(entry => [entry.name, entry]))
  const merged: AgentRosterEntry[] = []
  const seen = new Set<string>()
  for (const profile of statusProfiles ?? []) {
    const name = typeof profile === 'string' ? profile : profile.name
    if (!name || seen.has(name)) continue
    seen.add(name)
    const entry = enriched.get(name)
    merged.push({
      avatar: entry?.avatar,
      displayName: entry?.displayName,
      isDefault: (typeof profile !== 'string' && profile.is_default === true) || name === 'default' || (entry?.isDefault ?? false),
      name,
      preview: entry?.preview,
      sessionId: entry?.sessionId,
      startedAt: entry?.startedAt,
      title: entry?.title
    })
  }
  for (const entry of entries ?? []) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name)
      merged.push(entry)
    }
  }
  return merged
}

/**
 * Gateway-level roster lookup. profiles.list is unscoped by definition: it
 * inventories profiles rather than reading one profile's data.
 */
export function createAgentsApi(api: GatewayApi) {
  return {
    list: (signal?: AbortSignal): Promise<AgentRosterEntry[]> =>
      api.rpc<unknown>('profiles.list', {}, { signal }).then(parseAgentRoster)
  }
}