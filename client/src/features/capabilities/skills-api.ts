import type { GatewayApi } from '~/gateway/gateway-api'
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
}

export interface ActionStatusResponse {
  exit_code: number | null
  lines?: string[]
  pid?: number | null
  running: boolean
}

const HUB_TIMEOUT_MS = 45_000

export interface SkillsApi {
  list(signal?: AbortSignal): Promise<SkillInfo[]>
  content(name: string, signal?: AbortSignal): Promise<SkillContent>
  toggle(name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }>
  create(body: { category?: string; content: string; name: string }, signal?: AbortSignal): Promise<{ name: string; ok: boolean }>
  updateContent(name: string, content: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }>
  learningNode(id: string, signal?: AbortSignal): Promise<LearningNodeDetail>
  editLearningNode(id: string, content: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }>
  archiveLearningNode(id: string, signal?: AbortSignal): Promise<{ message: string; ok: boolean }>
  hubSources(signal?: AbortSignal): Promise<SkillHubSourcesResponse>
  hubSearch(query: string, source?: string, limit?: number, signal?: AbortSignal): Promise<SkillHubSearchResponse>
  hubPreview(identifier: string, signal?: AbortSignal): Promise<SkillHubPreview>
  hubScan(identifier: string, signal?: AbortSignal): Promise<SkillHubScanResult>
  hubInstall(identifier: string, signal?: AbortSignal): Promise<ActionStartResponse>
  hubUninstall(name: string, signal?: AbortSignal): Promise<ActionStartResponse>
  hubUpdate(signal?: AbortSignal): Promise<ActionStartResponse>
}

export function createSkillsApi(api: GatewayApi): SkillsApi {
  return {
    list: (signal?: AbortSignal) => api.request('/api/skills', { signal }),
    content: (name: string, signal?: AbortSignal) => api.request(`/api/skills/content?name=${encodeURIComponent(name)}`, { signal }),
    toggle: (name: string, enabled: boolean, signal?: AbortSignal) =>
      api.request('/api/skills/toggle', { body: { enabled, name, profile: api.profileKey }, method: 'PUT', signal }),
    create: (body: { category?: string; content: string; name: string }, signal?: AbortSignal) =>
      api.request('/api/skills', { body: { ...body, profile: api.profileKey }, method: 'POST', signal }),
    updateContent: (name: string, content: string, signal?: AbortSignal) =>
      api.request('/api/skills/content', { body: { content, name, profile: api.profileKey }, method: 'PUT', signal }),
    learningNode: (id: string, signal?: AbortSignal) => api.request(`/api/learning/node?id=${encodeURIComponent(id)}`, { signal }),
    editLearningNode: (id: string, content: string, signal?: AbortSignal) =>
      api.request('/api/learning/node', { body: { content, id, profile: api.profileKey }, method: 'PUT', signal }),
    archiveLearningNode: (id: string, signal?: AbortSignal) =>
      api.request('/api/learning/node', { body: { id, profile: api.profileKey }, method: 'DELETE', signal }),
    hubSources: (signal?: AbortSignal) => api.request('/api/skills/hub/sources', { signal, timeoutMs: HUB_TIMEOUT_MS }),
    hubSearch: (query: string, source = 'all', limit = 20, signal?: AbortSignal) =>
      api.request('/api/skills/hub/search', { params: { limit, q: query, source }, signal, timeoutMs: HUB_TIMEOUT_MS }),
    hubPreview: (identifier: string, signal?: AbortSignal) =>
      api.request(`/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}`, { signal, timeoutMs: HUB_TIMEOUT_MS }),
    hubScan: (identifier: string, signal?: AbortSignal) =>
      api.request(`/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`, { signal, timeoutMs: HUB_TIMEOUT_MS }),
    hubInstall: (identifier: string, signal?: AbortSignal) =>
      api.request('/api/skills/hub/install', { body: { identifier, profile: api.profileKey }, method: 'POST', signal }),
    hubUninstall: (name: string, signal?: AbortSignal) =>
      api.request('/api/skills/hub/uninstall', { body: { name, profile: api.profileKey }, method: 'POST', signal }),
    hubUpdate: (signal?: AbortSignal) =>
      api.request('/api/skills/hub/update', { body: { profile: api.profileKey }, method: 'POST', signal })
  }
}

function actionState(value: ActionStatusResponse): RemoteActionState<ActionStatusResponse> {
  return {
    result: value,
    status: value.running ? 'running' : value.exit_code === 0 ? 'complete' : 'failed'
  }
}

export async function runSkillHubAction(
  api: GatewayApi,
  start: (signal: AbortSignal) => Promise<ActionStartResponse>,
  signal?: AbortSignal,
  isCurrentScope?: () => boolean
): Promise<RemoteActionState<ActionStatusResponse>> {
  let name = ''
  return runRemoteAction<ActionStatusResponse>({
    gateway: api.gateway,
    isCurrentScope,
    maxAttempts: 120,
    poll: async (_gateway, pollSignal) =>
      actionState(
        // Action status is owned by the dashboard process. The route has no
        // profile scope; the action name returned by the start endpoint is the
        // authoritative handle.
        await api.unscoped<ActionStatusResponse>(`/api/actions/${encodeURIComponent(name)}/status`, { signal: pollSignal })
      ),
    signal,
    start: async (_gateway, startSignal) => {
      const response = assertRemoteActionStart(await start(startSignal))
      name = remoteActionName(response)
      return { result: undefined, status: response.background === false ? 'complete' : 'running' }
    }
  })
}