import type { GatewayApi } from '~/gateway/gateway-api'

/** One agent row on the main screen: a gateway profile plus its latest-conversation data when known. */
import type { GroupRoom } from '~/features/groups/group-model'
import { groupRoomsFromRoster } from '~/features/groups/group-model'

export interface AgentRosterEntry {
  avatar?: string
  description?: string
  displayName?: string
  hasAvatar?: boolean
  isDefault: boolean
  /** The desktop Bot Mode's per-bot meta, synced via profiles.configure
   *  ui_meta['hermes-bots'] (apps/desktop/src/plugins/hermes-bots/data.ts
   *  saveBotMeta) and mirrored back on every profiles.list row
   *  (tui_gateway/methods_profiles.py rides profile.yaml's ui_meta block). */
  meta?: BotMeta
  name: string
  preview?: string
  sessionId?: string
  startedAt?: number
  title?: string
}

/** Bot identity + avatar customization, ported from the desktop BotMeta
 *  (apps/desktop/src/plugins/hermes-bots/types.ts). The photo data URL rides
 *  ui_meta only when small; large pfps travel via profiles.get_asset and the
 *  row just carries `has_avatar`. */
export interface BotMeta {
  color?: string
  created?: number
  custom?: boolean
  image?: string
  imageKind?: 'photo' | 'shape'
  shape?: string
  title?: string
}

function parseBotMeta(record: Record<string, unknown>): BotMeta | undefined {
  const uiMeta = record.ui_meta
  if (typeof uiMeta !== 'object' || uiMeta === null) return undefined
  const raw = (uiMeta as Record<string, unknown>)['hermes-bots']
  if (typeof raw !== 'object' || raw === null) return undefined
  const source = raw as Record<string, unknown>
  const meta: BotMeta = {}
  if (typeof source.title === 'string' && source.title.trim()) meta.title = source.title.trim()
  if (typeof source.shape === 'string' && source.shape.trim()) meta.shape = source.shape.trim()
  if (typeof source.color === 'string' && source.color.trim()) meta.color = source.color.trim()
  if (typeof source.created === 'number' && Number.isFinite(source.created) && source.created > 0) meta.created = source.created
  if (typeof source.image === 'string' && /^(data:image\/|https?:\/\/)/i.test(source.image)) meta.image = source.image
  if (source.imageKind === 'photo' || source.imageKind === 'shape') meta.imageKind = source.imageKind
  if (source.custom === true) meta.custom = true
  return Object.keys(meta).length > 0 ? meta : undefined
}

/** What one profiles.list RPC yields: bot rows plus the desktop-mirrored
 *  group chats (they ride the default profile's ui_meta). */
export interface AgentRosterPage {
  entries: AgentRosterEntry[]
  groups: GroupRoom[]
  /** Present only on API results when the gateway returned a real inventory. */
  inventoryKnown?: boolean
}

export interface AgentProfileCreateInput {
  clone_all?: boolean
  clone_from?: null | string
  description?: string
  mirror_credentials?: boolean
  model?: string
  name: string
  no_skills?: boolean
  provider?: string
  share_auth?: boolean
  soul?: string
}

export interface AgentProfileCreateResult {
  mirrored?: Record<string, boolean | string>
  model_set?: boolean
  name: string
  ok: boolean
  path: string
  soul_written?: boolean
}

export interface ProfileCapabilityEntry {
  auth?: string
  description?: string
  enabled?: boolean
  fromCatalog?: boolean
  installed?: boolean
  name: string
  requires?: string[]
  tool_count?: number
  transport?: string
}

export interface AgentProfileDescribeResult {
  description?: string
  mcp_servers?: ProfileCapabilityEntry[]
  model?: {
    default?: string
    provider?: string
  }
  name?: string
  skills?: ProfileCapabilityEntry[]
  soul?: string
  toolsets?: ProfileCapabilityEntry[]
}

export interface AgentMcpCatalogResult {
  servers?: ProfileCapabilityEntry[]
}

export interface AgentProfileConfigureInput {
  confirm_expensive_model?: boolean
  description?: string
  disabled_skills?: string[]
  enabled_mcp_servers?: string[]
  enabled_toolsets?: string[]
  model?: string
  name: string
  provider?: string
  soul?: string
  ui_meta?: Record<string, unknown>
  ui_meta_expected_revisions?: Record<string, number>
}

export interface AgentProfileConfigureResult {
  applied?: Record<string, unknown>
  confirm_message?: string
  confirm_required?: boolean
  ok?: boolean
}

export interface AgentProfileAssetResult {
  asset?: string
  data?: string
  found?: boolean
  mime?: string
  ok?: boolean
  size?: number
}

export interface AgentCliResult {
  blocked?: boolean
  code?: number
  hint?: string
  ok?: boolean
  output?: string
}

export interface AgentModelOptionProvider {
  authenticated?: boolean
  models?: Array<string | { id?: string; name?: string }>
  name?: string
  slug: string
}

export interface AgentModelOptionsResult {
  providers?: AgentModelOptionProvider[]
}

export interface AgentAvatarGenerationResult {
  error?: string
  image?: string
  image_data?: string
  success?: boolean
}

/** CLI fallbacks are successful only when Hermes reports an explicit zero exit
 * code. A missing code must not turn an unsupported/malformed response into a
 * destructive success. */
export function isSuccessfulCliResult(result: AgentCliResult): boolean {
  return result.blocked !== true && result.ok !== false && result.code === 0
}

export function isSuccessfulProfileConfiguration(result: AgentProfileConfigureResult): boolean {
  return result.ok !== false && Object.values(result.applied ?? {}).every(value => value !== false)
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
    ...(typeof record.description === 'string' && record.description.trim() ? { description: record.description.trim() } : {}),
    displayName: typeof record.display_name === 'string' && record.display_name.trim()
      ? record.display_name.trim()
      : undefined,
    ...(record.has_avatar === true ? { hasAvatar: true } : {}),
    isDefault: record.is_default === true || (record.is_default === undefined && name === 'default'),
    meta: parseBotMeta(record),
    name,
    preview: typeof record.preview === 'string' && record.preview ? record.preview : undefined,
    sessionId: typeof record.session_id === 'string' && record.session_id
      ? record.session_id
      : typeof record.canonical_session_id === 'string' ? record.canonical_session_id : undefined,
    startedAt: toSeconds(record.last_active ?? record.started_at),
    // The wire's top-level title is the latest human SESSION's title (roster
    // enrichment), never the bot's name — the bot's own title, when the user
    // set one, lives in the Bot Mode meta (desktop labels.ts reads meta.title).
    title: parseBotMeta(record)?.title
  }
}

/** Parse a profiles.list response body: a bare array or a { profiles: [...] } wrapper. */
export function parseAgentRoster(response: unknown): AgentRosterEntry[] {
  return parseAgentRosterPage(response).entries
}

export function parseAgentRosterPage(response: unknown): AgentRosterPage {
  const items = Array.isArray(response)
    ? response
    : typeof response === 'object' && response !== null && Array.isArray((response as Record<string, unknown>).profiles)
      ? (response as { profiles: unknown[] }).profiles
      : []
  return {
    entries: items.map(normalizeAgentEntry).filter((entry): entry is AgentRosterEntry => entry !== null),
    groups: groupRoomsFromRoster(response)
  }
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
      description: entry?.description,
      displayName: entry?.displayName,
      hasAvatar: entry?.hasAvatar,
      isDefault: (typeof profile !== 'string' && profile.is_default === true) || name === 'default' || (entry?.isDefault ?? false),
      meta: entry?.meta,
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
export interface AgentsApi {
  clearModel(name: string, signal?: AbortSignal): Promise<AgentCliResult>
  configure(payload: AgentProfileConfigureInput, signal?: AbortSignal): Promise<AgentProfileConfigureResult>
  create(input: AgentProfileCreateInput | string, signal?: AbortSignal): Promise<AgentProfileCreateResult>
  delete(name: string, signal?: AbortSignal): Promise<AgentCliResult>
  describe(name: string, signal?: AbortSignal): Promise<AgentProfileDescribeResult>
  generateAvatar(prompt: string, signal?: AbortSignal): Promise<AgentAvatarGenerationResult>
  getAsset(name: string, signal?: AbortSignal): Promise<AgentProfileAssetResult>
  list(signal?: AbortSignal): Promise<AgentRosterPage>
  mcpCatalog(profile?: string, signal?: AbortSignal): Promise<AgentMcpCatalogResult>
  modelOptions(signal?: AbortSignal): Promise<AgentModelOptionsResult>
  setAsset(name: string, input: { clear?: boolean; data?: string }, signal?: AbortSignal): Promise<AgentProfileAssetResult>
}

/** Merge the compact Bot Mode metadata shape. Large image data deliberately
 * travels through profiles.set_asset rather than profile.yaml/ui_meta. */
export function botMetaForProfile(input: {
  color: null | string
  created?: number
  image: null | string
  shape: string
  title: string
}): Record<string, unknown> {
  return {
    color: input.color ?? null,
    ...(input.created === undefined ? {} : { created: input.created }),
    custom: true,
    imageKind: input.image ? 'photo' : 'shape',
    shape: input.shape,
    title: input.title.trim()
  }
}

export function createAgentsApi(api: GatewayApi): AgentsApi {
  const getAsset = (name: string, signal?: AbortSignal): Promise<AgentProfileAssetResult> =>
    api.rpc<AgentProfileAssetResult>('profiles.get_asset', { asset: 'avatar', name }, { signal })

  return {
    clearModel: (name, signal) => api.rpc<AgentCliResult>('cli.exec', {
      argv: ['--profile', name, 'config', 'unset', 'model']
    }, { signal }),
    configure: (payload, signal) => api.rpc<AgentProfileConfigureResult>('profiles.configure', payload as unknown as Record<string, unknown>, { signal }),
    create: (input, signal) => api.rpc<AgentProfileCreateResult>('profiles.create', (typeof input === 'string' ? { name: input } : input) as unknown as Record<string, unknown>, { signal }),
    delete: (name, signal) => api.rpc<AgentCliResult>('cli.exec', {
      argv: ['profile', 'delete', name, '--yes']
    }, { signal }),
    describe: (name, signal) => api.rpc<AgentProfileDescribeResult>('profiles.describe', { name }, { signal }),
    generateAvatar: (prompt, signal) => api.rpc<AgentAvatarGenerationResult>('image.generate', {
      aspect_ratio: 'square',
      prompt: `${prompt.trim()}. Avatar for an AI agent: centered, bold flat vector style, solid color background, no text.`
    }, { signal }),
    getAsset,
    list: (signal?: AbortSignal): Promise<AgentRosterPage> =>
      api.rpc<unknown>('profiles.list', {}, { signal }).then(async response => {
        const page = parseAgentRosterPage(response)
        // The compact list carries only has_avatar for large assets. Fetch
        // those assets here so roster rendering and the editor stay useful on
        // gateways that correctly keep base64 data out of ui_meta.
        const hydrated = await Promise.all(page.entries.map(async entry => {
          if (!entry.hasAvatar || entry.meta?.image || entry.avatar) return entry
          try {
            const asset = await getAsset(entry.name, signal)
            if (!asset.found || !asset.data) return entry
            return {
              ...entry,
              avatar: asset.data,
              meta: { ...(entry.meta ?? {}), image: asset.data, imageKind: 'photo' as const }
            }
          } catch {
            return entry
          }
        }))
        const inventoryKnown = Array.isArray(response) || (typeof response === 'object' && response !== null && Array.isArray((response as Record<string, unknown>).profiles))
        return { ...page, entries: hydrated, ...(inventoryKnown ? { inventoryKnown: true } : {}) }
      }),
    mcpCatalog: (profile, signal) => api.rpc<AgentMcpCatalogResult>('mcp.catalog', profile ? { profile } : {}, { signal }),
    modelOptions: signal => api.rpc<AgentModelOptionsResult>('model.options', {
      explicit_only: false,
      include_unconfigured: true
    }, { signal }),
    setAsset: (name, input, signal) => api.rpc<AgentProfileAssetResult>('profiles.set_asset', {
      asset: 'avatar',
      ...(input.clear ? { clear: true } : { data: input.data }),
      name
    }, { signal })
  }
}
