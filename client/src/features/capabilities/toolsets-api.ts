import type { GatewayPort } from '~/gateway/gateway-port'
import { profileKey, profilePath, profileParams, type MobileProfile } from '~/gateway/profile-path'
import { assertRemoteActionStart, remoteActionName, runRemoteAction, type RemoteActionState } from '~/gateway/remote-action'
import type { ToolEnvVar, ToolProvider, ToolsetInfo } from '~/lib/types'
import type { ActionStartResponse, ActionStatusResponse } from './skills-api'

export interface ToolsetConfig {
  active_extract_backend?: string | null
  active_provider?: string | null
  active_search_backend?: string | null
  has_category: boolean
  name: string
  providers: ToolProvider[]
}

export interface ToolsetModelsResponse {
  current: string | null
  default: string | null
  has_models: boolean
  models: Array<{ display: string; id: string; price: string; speed: string; strengths: string }>
  name: string
  provider?: string | null
}

export interface TerminalBackend {
  active: boolean
  description: string
  detail?: string | null
  label: string
  name: string
  status: 'needs_setup' | 'ready' | 'unavailable' | string
}

export interface TerminalBackendsResponse {
  active: string
  backends: TerminalBackend[]
}

export interface ComputerUseStatus {
  available?: boolean
  detail?: string
  [key: string]: unknown
}

async function request<T>(gateway: GatewayPort, path: string, options: { body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return (await gateway.request<T>({ ...options, path })).body
}

export const toolsetsApi = {
  list(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ToolsetInfo[]> {
    return request(gateway, profilePath('/api/tools/toolsets', profile), { signal })
  },

  config(gateway: GatewayPort, profile: MobileProfile, name: string, signal?: AbortSignal): Promise<ToolsetConfig> {
    return request(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}/config`, profile), { signal })
  },

  models(gateway: GatewayPort, profile: MobileProfile, name: string, provider?: string, signal?: AbortSignal): Promise<ToolsetModelsResponse> {
    const query = profileParams(profile, provider ? { provider } : {})
    return request(gateway, `/api/tools/toolsets/${encodeURIComponent(name)}/models?${query}`, { signal })
  },

  toggle(gateway: GatewayPort, profile: MobileProfile, name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }> {
    return request(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}`, profile), { body: { enabled, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  selectProvider(gateway: GatewayPort, profile: MobileProfile, name: string, provider: string, capability?: 'extract' | 'search', signal?: AbortSignal) {
    return request<{ feature?: string; name: string; needs_nous_auth?: boolean; ok: boolean; provider: string }>(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}/provider`, profile), {
      body: capability ? { capability, profile: profileKey(profile), provider } : { profile: profileKey(profile), provider },
      method: 'PUT',
      signal
    })
  },

  selectModel(gateway: GatewayPort, profile: MobileProfile, name: string, model: string, provider?: string, signal?: AbortSignal) {
    return request<{ model: string; name: string; ok: boolean }>(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}/model`, profile), {
      body: { model, profile: profileKey(profile), provider },
      method: 'PUT',
      signal
    })
  },

  saveEnv(gateway: GatewayPort, profile: MobileProfile, name: string, env: Record<string, string>, signal?: AbortSignal) {
    return request<{ is_set: Record<string, boolean>; name: string; ok: boolean; saved: string[]; skipped: string[] }>(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}/env`, profile), {
      body: { env, profile: profileKey(profile) },
      method: 'PUT',
      signal
    })
  },

  postSetup(gateway: GatewayPort, profile: MobileProfile, name: string, key: string, signal?: AbortSignal): Promise<ActionStartResponse & { key: string }> {
    return request(gateway, profilePath(`/api/tools/toolsets/${encodeURIComponent(name)}/post-setup`, profile), {
      body: { key, profile: profileKey(profile) },
      method: 'POST',
      signal
    })
  },

  terminalBackends(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<TerminalBackendsResponse> {
    return request(gateway, profilePath('/api/tools/terminal/backends', profile), { signal })
  },

  selectTerminalBackend(gateway: GatewayPort, profile: MobileProfile, backend: string, signal?: AbortSignal) {
    return request<{ backend: string; ok: boolean }>(gateway, profilePath('/api/tools/terminal/backend', profile), { body: { backend, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  computerUseStatus(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ComputerUseStatus> {
    return request(gateway, profilePath('/api/tools/computer-use/status', profile), { signal })
  },

  grantComputerUsePermissions(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ActionStartResponse> {
    return request(gateway, profilePath('/api/tools/computer-use/permissions/grant', profile), { method: 'POST', signal })
  }
}

export function toolActionStatus(gateway: GatewayPort, _profile: MobileProfile, name: string, signal?: AbortSignal): Promise<ActionStatusResponse> {
  return request(gateway, `/api/actions/${encodeURIComponent(name)}/status`, { signal })
}

export async function runToolsetAction(
  gateway: GatewayPort,
  profile: MobileProfile,
  start: (signal: AbortSignal) => Promise<ActionStartResponse>,
  signal?: AbortSignal,
  getScopeEpoch?: () => number
): Promise<RemoteActionState<ActionStatusResponse>> {
  let action = ''
  return runRemoteAction<ActionStatusResponse>({
    gateway,
    getScopeEpoch,
    maxAttempts: 120,
    poll: async (_gateway, pollSignal) => {
      const status = await toolActionStatus(gateway, profile, action, pollSignal)
      return { result: status, status: status.running ? 'running' : status.exit_code === 0 ? 'complete' : 'failed' }
    },
    signal,
    start: async (_gateway, startSignal) => {
      const response = assertRemoteActionStart(await start(startSignal))
      action = remoteActionName(response)
      return { result: undefined, status: response.background === false ? 'complete' : 'running' }
    }
  })
}

export type { ToolEnvVar }
