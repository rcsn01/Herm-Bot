import type { BillingStateResponse, SubscriptionStateResponse } from '@hermes/shared/billing'
import type { GatewayApi } from '~/gateway/gateway-api'
import type { ConfigSchemaResponse, CustomEndpointUpdate, CustomEndpointsResponse, EnvVarInfo, HermesConfigRecord, MemoryProviderConfig, MemoryProviderOAuthStatus, MemoryStatusResponse, OAuthPollResponse, OAuthProvidersResponse, OAuthStartResponse } from '~/lib/types'

const SETTINGS_TIMEOUT_MS = 60_000
const MEMORY_SETUP_TIMEOUT_MS = 5 * 60_000
const DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE = 'This gateway exposes memory management only for its default profile.'
const DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE = 'This gateway exposes plugin management only for its default profile.'

export interface SettingsApi {
  config(signal?: AbortSignal): Promise<HermesConfigRecord>
  schema(signal?: AbortSignal): Promise<ConfigSchemaResponse>
  savePartial(config: HermesConfigRecord, signal?: AbortSignal): Promise<{ ok: boolean }>
  memoryStatus(signal?: AbortSignal): Promise<MemoryStatusResponse>
  memoryProviderConfig(provider: string, signal?: AbortSignal): Promise<MemoryProviderConfig>
  saveMemoryProviderConfig(provider: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<{ active?: string; ok: boolean }>
  setupMemoryProvider(provider: string, values?: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>
  selectMemoryProvider(provider: string, signal?: AbortSignal): Promise<{ active: string; ok: boolean }>
  resetMemory(target: 'all' | 'memory' | 'user', signal?: AbortSignal): Promise<{ deleted: string[]; ok: boolean }>
  memoryOAuthStatus(provider: string, signal?: AbortSignal): Promise<MemoryProviderOAuthStatus>
  startMemoryOAuth(provider: string, signal?: AbortSignal): Promise<MemoryProviderOAuthStatus>
  billingState(signal?: AbortSignal): Promise<BillingStateResponse>
  subscriptionState(signal?: AbortSignal): Promise<SubscriptionStateResponse>
  elevenLabsVoices(signal?: AbortSignal): Promise<{ available: boolean; voices: Array<{ label: string; name: string; voice_id: string }> }>
  status(signal?: AbortSignal): Promise<Record<string, unknown>>
  env(signal?: AbortSignal): Promise<Record<string, EnvVarInfo>>
  setEnv(key: string, value: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  deleteEnv(key: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  revealEnv(key: string, signal?: AbortSignal): Promise<{ key: string; value: string }>
  validateProvider(key: string, value: string, apiKey?: string, signal?: AbortSignal): Promise<{ message: string; models?: string[]; ok: boolean; reachable: boolean }>
  oauthProviders(signal?: AbortSignal): Promise<OAuthProvidersResponse>
  oauthStart(provider: string, signal?: AbortSignal): Promise<OAuthStartResponse>
  oauthPoll(provider: string, sessionId: string, signal?: AbortSignal): Promise<OAuthPollResponse>
  oauthSubmit(provider: string, sessionId: string, code: string, signal?: AbortSignal): Promise<{ message?: string; ok: boolean; status: 'approved' | 'error' }>
  oauthCancel(sessionId: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  customEndpoints(signal?: AbortSignal): Promise<CustomEndpointsResponse>
  saveCustomEndpoint(endpoint: CustomEndpointUpdate, signal?: AbortSignal): Promise<CustomEndpointsResponse>
  deleteCustomEndpoint(id: string, signal?: AbortSignal): Promise<CustomEndpointsResponse>
  activateCustomEndpoint(id: string, signal?: AbortSignal): Promise<{ model: string; ok: boolean; provider: string }>
  validateCustomEndpoint(body: CustomEndpointUpdate, signal?: AbortSignal): Promise<{ message: string; models: string[]; ok: boolean; reachable: boolean }>
  sessions(signal?: AbortSignal): Promise<{ sessions: Array<{ archived?: boolean; id: string; last_active?: number; message_count?: number; preview?: string; title?: string }> }>
  restoreSession(id: string, signal?: AbortSignal): Promise<void>
  deleteSession(id: string, signal?: AbortSignal): Promise<void>
  pluginsHub(signal?: AbortSignal): Promise<{ plugins: Array<{ can_remove?: boolean; description?: string; name: string; runtime_status?: string; source?: string; version?: string }>; providers?: Record<string, unknown> }>
  pluginAction(name: string, action: 'disable' | 'enable', signal?: AbortSignal): Promise<{ ok: boolean }>
  removePlugin(name: string, signal?: AbortSignal): Promise<{ ok: boolean }>
}

export function createSettingsApi(api: GatewayApi): SettingsApi {
  return {
    config: (signal?: AbortSignal) => api.request('/api/config', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    schema: (signal?: AbortSignal) => api.request('/api/config/schema', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    savePartial: (config: HermesConfigRecord, signal?: AbortSignal) =>
      api.request('/api/config', { body: { config }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    memoryStatus: async (signal?: AbortSignal) =>
      api.defaultOnly(DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE, '/api/memory', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    memoryProviderConfig: (provider: string, signal?: AbortSignal) =>
      api.request(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    saveMemoryProviderConfig: (provider: string, values: Record<string, unknown>, signal?: AbortSignal) =>
      api.request(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, {
        body: { values },
        method: 'PUT',
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      }),
    setupMemoryProvider: async (provider: string, values: Record<string, unknown> = {}, signal?: AbortSignal) =>
      api.defaultOnly(DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE, `/api/memory/providers/${encodeURIComponent(provider)}/setup`, {
        body: { values },
        method: 'POST',
        signal,
        timeoutMs: MEMORY_SETUP_TIMEOUT_MS
      }),
    selectMemoryProvider: async (provider: string, signal?: AbortSignal) =>
      api.defaultOnly(DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE, '/api/memory/provider', {
        body: { provider },
        method: 'PUT',
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      }),
    resetMemory: async (target: 'all' | 'memory' | 'user', signal?: AbortSignal) =>
      api.defaultOnly(DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE, '/api/memory/reset', {
        body: { target },
        method: 'POST',
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      }),
    memoryOAuthStatus: (provider: string, signal?: AbortSignal) =>
      api.request(`/api/memory/providers/${encodeURIComponent(provider)}/oauth/status`, { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    startMemoryOAuth: (provider: string, signal?: AbortSignal) =>
      api.request(`/api/memory/providers/${encodeURIComponent(provider)}/oauth/start`, { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    billingState: (signal?: AbortSignal) => {
      // The billing RPC is account-wide and explicitly has no profile scope.
      return api.rpc<BillingStateResponse>('billing.state', {}, { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
    },
    subscriptionState: (signal?: AbortSignal) => {
      // The subscription RPC is account-wide and explicitly has no profile scope.
      return api.rpc<SubscriptionStateResponse>('subscription.state', {}, { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
    },
    elevenLabsVoices: (signal?: AbortSignal) =>
      api.request('/api/audio/elevenlabs/voices', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    status: (signal?: AbortSignal) => {
      // /api/status is the machine-level liveness probe; profile query
      // parameters are ignored by the gateway and must not imply profile data.
      return api.unscoped('/api/status', { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
    },
    env: (signal?: AbortSignal) => api.request('/api/env', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    setEnv: (key: string, value: string, signal?: AbortSignal) =>
      api.request('/api/env', { body: { key, profile: api.profileKey, value }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    deleteEnv: (key: string, signal?: AbortSignal) =>
      api.request('/api/env', { body: { key, profile: api.profileKey }, method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    revealEnv: (key: string, signal?: AbortSignal) =>
      api.request('/api/env/reveal', { body: { key, profile: api.profileKey }, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    validateProvider: (key: string, value: string, apiKey = '', signal?: AbortSignal) =>
      api.request('/api/providers/validate', {
        body: { api_key: apiKey, key, profile: api.profileKey, value },
        method: 'POST',
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      }),
    oauthProviders: (signal?: AbortSignal) => api.request('/api/providers/oauth', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    oauthStart: (provider: string, signal?: AbortSignal) =>
      api.request(`/api/providers/oauth/${encodeURIComponent(provider)}/start`, { body: {}, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    oauthPoll: (provider: string, sessionId: string, signal?: AbortSignal) => {
      // Polling reads the process-global in-memory flow registry; the opaque
      // session id, not a profile query, identifies the flow.
      return api.unscoped(`/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}`, {
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      })
    },
    oauthSubmit: (provider: string, sessionId: string, code: string, signal?: AbortSignal) =>
      api.request(`/api/providers/oauth/${encodeURIComponent(provider)}/submit`, {
        body: { session_id: sessionId, code },
        method: 'POST',
        signal,
        timeoutMs: SETTINGS_TIMEOUT_MS
      }),
    oauthCancel: (sessionId: string, signal?: AbortSignal) =>
      api.unscoped(`/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    customEndpoints: (signal?: AbortSignal) => api.request('/api/providers/custom-endpoints', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    saveCustomEndpoint: (endpoint: CustomEndpointUpdate, signal?: AbortSignal) =>
      api.request('/api/providers/custom-endpoints', { body: endpoint, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    deleteCustomEndpoint: (id: string, signal?: AbortSignal) =>
      api.request(`/api/providers/custom-endpoints/${encodeURIComponent(id)}`, { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    activateCustomEndpoint: (id: string, signal?: AbortSignal) =>
      api.request(`/api/providers/custom-endpoints/${encodeURIComponent(id)}/activate`, { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    validateCustomEndpoint: (body: CustomEndpointUpdate, signal?: AbortSignal) =>
      api.request('/api/providers/custom-endpoints/validate', { body, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    sessions: (signal?: AbortSignal) =>
      api.request('/api/sessions?archived=only&limit=100&order=recent', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    restoreSession: (id: string, signal?: AbortSignal) =>
      api
        .request(`/api/sessions/${encodeURIComponent(id)}`, { body: { archived: false }, method: 'PATCH', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
        .then(() => undefined),
    deleteSession: (id: string, signal?: AbortSignal) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }).then(() => undefined),
    pluginsHub: (signal?: AbortSignal) =>
      api.defaultOnly(DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE, '/api/dashboard/plugins/hub', { signal, timeoutMs: SETTINGS_TIMEOUT_MS }),
    pluginAction: (name: string, action: 'disable' | 'enable', signal?: AbortSignal) =>
      api.defaultOnly(
        DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE,
        `/api/dashboard/agent-plugins/${name.split('/').map(encodeURIComponent).join('/')}/${action}`,
        { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS }
      ),
    removePlugin: (name: string, signal?: AbortSignal) =>
      api.defaultOnly(
        DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE,
        `/api/dashboard/agent-plugins/${name.split('/').map(encodeURIComponent).join('/')}`,
        { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }
      )
  }
}