import type { GatewayPort } from '~/gateway/gateway-port'
import { profileKey, profilePath, profileParams, type MobileProfile } from '~/gateway/profile-path'
import { assertRemoteActionStart, remoteActionName, runRemoteAction, type RemoteActionState } from '~/gateway/remote-action'
import type { SkillInfo } from '~/lib/types'

export interface SkillContent {
  content: string
  name: string
  path: string
}

export interface LearningNodeDetail {
  content: string
  kind: 'memory' | 'skill'
  label: string
  ok: boolean
}

export interface SkillHubSource {
  available?: boolean
  id: string
  label: string
  rate_limited?: boolean
  searchable?: boolean
}

export interface SkillHubSourcesResponse {
  featured: SkillHubResult[]
  index_available: boolean
  installed: Record<string, string> | string[]
  sources: SkillHubSource[]
}

export interface SkillHubResult {
  category?: string
  description: string
  identifier: string
  name: string
  repo?: string | null
  source: string
  tags?: string[]
  trust_level?: string
}

export interface SkillHubSearchResponse {
  installed: Record<string, string> | string[]
  results: SkillHubResult[]
  source_counts: Record<string, number>
  timed_out: string[]
}

export interface SkillHubPreview extends SkillHubResult {
  files: string[]
  skill_md: string
}

export interface SkillHubScanFinding {
  category: string
  description: string
  file: string
  line: number | null
  severity: string
}

export interface SkillHubScanResult {
  findings: SkillHubScanFinding[]
  identifier: string
  name: string
  policy: 'allow' | 'ask' | 'block'
  policy_reason: string | null
  severity_counts: Record<string, number>
  source: string
  summary: string
  trust_level: string
  verdict: string
}

export interface ActionStartResponse {
  action?: string
  background?: boolean
  name: string
  ok: boolean
  pid?: number
}

export interface ActionStatusResponse {
  exit_code: number | null
  lines?: string[]
  pid?: number | null
  running: boolean
}

const HUB_TIMEOUT_MS = 45_000

async function request<T>(gateway: GatewayPort, path: string, options: { body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return (await gateway.request<T>({ ...options, path })).body
}

export const skillsApi = {
  list(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<SkillInfo[]> {
    return request(gateway, profilePath('/api/skills', profile), { signal })
  },

  content(gateway: GatewayPort, profile: MobileProfile, name: string, signal?: AbortSignal): Promise<SkillContent> {
    return request(gateway, profilePath(`/api/skills/content?name=${encodeURIComponent(name)}`, profile), { signal })
  },

  toggle(gateway: GatewayPort, profile: MobileProfile, name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }> {
    return request(gateway, profilePath('/api/skills/toggle', profile), { body: { enabled, name, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  create(gateway: GatewayPort, profile: MobileProfile, body: { category?: string; content: string; name: string }, signal?: AbortSignal): Promise<{ name: string; ok: boolean }> {
    return request(gateway, profilePath('/api/skills', profile), { body: { ...body, profile: profileKey(profile) }, method: 'POST', signal })
  },

  updateContent(gateway: GatewayPort, profile: MobileProfile, name: string, content: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }> {
    return request(gateway, profilePath('/api/skills/content', profile), { body: { content, name, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  learningNode(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<LearningNodeDetail> {
    return request(gateway, profilePath(`/api/learning/node?id=${encodeURIComponent(id)}`, profile), { signal })
  },

  editLearningNode(gateway: GatewayPort, profile: MobileProfile, id: string, content: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }> {
    return request(gateway, profilePath('/api/learning/node', profile), { body: { content, id, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  archiveLearningNode(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }> {
    return request(gateway, profilePath('/api/learning/node', profile), { body: { id, profile: profileKey(profile) }, method: 'DELETE', signal })
  },

  hubSources(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<SkillHubSourcesResponse> {
    return request(gateway, profilePath('/api/skills/hub/sources', profile), { signal, timeoutMs: HUB_TIMEOUT_MS })
  },

  hubSearch(gateway: GatewayPort, profile: MobileProfile, query: string, source = 'all', limit = 20, signal?: AbortSignal): Promise<SkillHubSearchResponse> {
    const path = profilePath(`/api/skills/hub/search?${profileParams(profile, { limit, q: query, source })}`, profile)
    return request(gateway, path, { signal, timeoutMs: HUB_TIMEOUT_MS })
  },

  hubPreview(gateway: GatewayPort, profile: MobileProfile, identifier: string, signal?: AbortSignal): Promise<SkillHubPreview> {
    return request(gateway, profilePath(`/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}`, profile), { signal, timeoutMs: HUB_TIMEOUT_MS })
  },

  hubScan(gateway: GatewayPort, profile: MobileProfile, identifier: string, signal?: AbortSignal): Promise<SkillHubScanResult> {
    return request(gateway, profilePath(`/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`, profile), { signal, timeoutMs: HUB_TIMEOUT_MS })
  },

  hubInstall(gateway: GatewayPort, profile: MobileProfile, identifier: string, signal?: AbortSignal): Promise<ActionStartResponse> {
    return request(gateway, profilePath('/api/skills/hub/install', profile), { body: { identifier, profile: profileKey(profile) }, method: 'POST', signal })
  },

  hubUninstall(gateway: GatewayPort, profile: MobileProfile, name: string, signal?: AbortSignal): Promise<ActionStartResponse> {
    return request(gateway, profilePath('/api/skills/hub/uninstall', profile), { body: { name, profile: profileKey(profile) }, method: 'POST', signal })
  },

  hubUpdate(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ActionStartResponse> {
    return request(gateway, profilePath('/api/skills/hub/update', profile), { body: { profile: profileKey(profile) }, method: 'POST', signal })
  }
}

export function actionStatus(gateway: GatewayPort, _profile: MobileProfile, name: string, signal?: AbortSignal): Promise<ActionStatusResponse> {
  // Action status is owned by the dashboard process. The route has no
  // profile scope; the action name returned by the start endpoint is the
  // authoritative handle.
  return request(gateway, `/api/actions/${encodeURIComponent(name)}/status`, { signal })
}

function actionState(value: ActionStatusResponse): RemoteActionState<ActionStatusResponse> {
  return {
    result: value,
    status: value.running ? 'running' : value.exit_code === 0 ? 'complete' : 'failed'
  }
}

export async function runSkillHubAction(
  gateway: GatewayPort,
  profile: MobileProfile,
  start: (signal: AbortSignal) => Promise<ActionStartResponse>,
  signal?: AbortSignal,
  getScopeEpoch?: () => number
): Promise<RemoteActionState<ActionStatusResponse>> {
  let name = ''
  return runRemoteAction<ActionStatusResponse>({
    gateway,
    getScopeEpoch,
    maxAttempts: 120,
    poll: async (_gateway, pollSignal) => actionState(await actionStatus(gateway, profile, name, pollSignal)),
    signal,
    start: async (_gateway, startSignal) => {
      const response = assertRemoteActionStart(await start(startSignal))
      name = remoteActionName(response)
      return { result: undefined, status: response.background === false ? 'complete' : 'running' }
    }
  })
}
