import type { GatewayApi } from '~/gateway/gateway-api'
import type { RemoteActionStartResponse } from '~/gateway/remote-action'
import type { ToolEnvVar, ToolProvider, ToolsetInfo } from '~/lib/types'

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

export interface ToolsetsApi {
  list(signal?: AbortSignal): Promise<ToolsetInfo[]>
  config(name: string, signal?: AbortSignal): Promise<ToolsetConfig>
  models(name: string, provider?: string, signal?: AbortSignal): Promise<ToolsetModelsResponse>
  toggle(name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }>
  selectProvider(name: string, provider: string, capability?: 'extract' | 'search', signal?: AbortSignal): Promise<{ feature?: string; name: string; needs_nous_auth?: boolean; ok: boolean; provider: string }>
  selectModel(name: string, model: string, provider?: string, signal?: AbortSignal): Promise<{ model: string; name: string; ok: boolean }>
  saveEnv(name: string, env: Record<string, string>, signal?: AbortSignal): Promise<{ is_set: Record<string, boolean>; name: string; ok: boolean; saved: string[]; skipped: string[] }>
  postSetup(name: string, key: string, signal?: AbortSignal): Promise<RemoteActionStartResponse & { key: string }>
  terminalBackends(signal?: AbortSignal): Promise<TerminalBackendsResponse>
  selectTerminalBackend(backend: string, signal?: AbortSignal): Promise<{ backend: string; ok: boolean }>
  computerUseStatus(signal?: AbortSignal): Promise<ComputerUseStatus>
  grantComputerUsePermissions(signal?: AbortSignal): Promise<RemoteActionStartResponse>
}

export function createToolsetsApi(api: GatewayApi): ToolsetsApi {
  return {
    list: (signal?: AbortSignal) => api.request('/api/tools/toolsets', { signal }),
    config: (name: string, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/config`, { signal }),
    models: (name: string, provider?: string, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/models`, { params: provider ? { provider } : {}, signal }),
    toggle: (name: string, enabled: boolean, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}`, {
        body: { enabled, profile: api.profileKey },
        method: 'PUT',
        signal
      }),
    selectProvider: (name: string, provider: string, capability?: 'extract' | 'search', signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/provider`, {
        body: capability ? { capability, profile: api.profileKey, provider } : { profile: api.profileKey, provider },
        method: 'PUT',
        signal
      }),
    selectModel: (name: string, model: string, provider?: string, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/model`, {
        body: { model, profile: api.profileKey, provider },
        method: 'PUT',
        signal
      }),
    saveEnv: (name: string, env: Record<string, string>, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/env`, {
        body: { env, profile: api.profileKey },
        method: 'PUT',
        signal
      }),
    postSetup: (name: string, key: string, signal?: AbortSignal) =>
      api.request(`/api/tools/toolsets/${encodeURIComponent(name)}/post-setup`, {
        body: { key, profile: api.profileKey },
        method: 'POST',
        signal
      }),
    terminalBackends: (signal?: AbortSignal) => api.request('/api/tools/terminal/backends', { signal }),
    selectTerminalBackend: (backend: string, signal?: AbortSignal) =>
      api.request('/api/tools/terminal/backend', { body: { backend, profile: api.profileKey }, method: 'PUT', signal }),
    computerUseStatus: (signal?: AbortSignal) => api.request('/api/tools/computer-use/status', { signal }),
    grantComputerUsePermissions: (signal?: AbortSignal) =>
      api.request('/api/tools/computer-use/permissions/grant', { method: 'POST', signal })
  }
}

export type { ToolEnvVar }
