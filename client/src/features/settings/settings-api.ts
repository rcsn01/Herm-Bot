import type { BillingStateResponse, SubscriptionStateResponse } from '@hermes/shared/billing'
import type { GatewayPort } from '~/gateway/gateway-port'
import { GatewayError } from '~/gateway/gateway-error'
import { profileKey, profilePath, type MobileProfile } from '~/gateway/profile-path'
import type { ConfigSchemaResponse, CustomEndpointUpdate, CustomEndpointsResponse, EnvVarInfo, HermesConfigRecord, MemoryProviderConfig, MemoryProviderOAuthStatus, MemoryStatusResponse, OAuthPollResponse, OAuthProvidersResponse, OAuthStartResponse } from '~/lib/types'

const SETTINGS_TIMEOUT_MS = 60_000
const MEMORY_SETUP_TIMEOUT_MS = 5 * 60_000
const DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE = 'This gateway exposes memory management only for its default profile.'
const DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE = 'This gateway exposes plugin management only for its default profile.'

function requireDefaultProfileRoute(profile: MobileProfile, message: string): void {
  if (profileKey(profile) !== 'default') {
    throw new GatewayError(message, {
      code: 'PROFILE_SCOPE_UNSUPPORTED',
      kind: 'unsupported',
      retryable: false
    })
  }
}

function requireDefaultProfileForMemoryRoute(profile: MobileProfile): void {
  requireDefaultProfileRoute(profile, DEFAULT_PROFILE_ONLY_MEMORY_MESSAGE)
}

function requireDefaultProfileForPluginRoute(profile: MobileProfile): void {
  requireDefaultProfileRoute(profile, DEFAULT_PROFILE_ONLY_PLUGIN_MESSAGE)
}

async function request<T>(gateway: GatewayPort, path: string, options: { body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return (await gateway.request<T>({ path, ...options })).body
}

export const settingsApi = {
  config(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<HermesConfigRecord> {
    return request(gateway, profilePath('/api/config', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  schema(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<ConfigSchemaResponse> {
    return request(gateway, profilePath('/api/config/schema', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  savePartial(gateway: GatewayPort, profile: MobileProfile, config: HermesConfigRecord, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, profilePath('/api/config', profile), { body: { config }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  async memoryStatus(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<MemoryStatusResponse> {
    requireDefaultProfileForMemoryRoute(profile)
    return request(gateway, '/api/memory', { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  memoryProviderConfig(gateway: GatewayPort, profile: MobileProfile, provider: string, signal?: AbortSignal): Promise<MemoryProviderConfig> {
    return request(gateway, profilePath(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  saveMemoryProviderConfig(gateway: GatewayPort, profile: MobileProfile, provider: string, values: Record<string, unknown>, signal?: AbortSignal): Promise<{ active?: string; ok: boolean }> {
    return request(gateway, profilePath(`/api/memory/providers/${encodeURIComponent(provider)}/config?surface=declared`, profile), { body: { values }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  async setupMemoryProvider(gateway: GatewayPort, profile: MobileProfile, provider: string, values: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    requireDefaultProfileForMemoryRoute(profile)
    return request(gateway, `/api/memory/providers/${encodeURIComponent(provider)}/setup`, { body: { values }, method: 'POST', signal, timeoutMs: MEMORY_SETUP_TIMEOUT_MS })
  },
  async selectMemoryProvider(gateway: GatewayPort, profile: MobileProfile, provider: string, signal?: AbortSignal): Promise<{ active: string; ok: boolean }> {
    requireDefaultProfileForMemoryRoute(profile)
    return request(gateway, '/api/memory/provider', { body: { provider }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  async resetMemory(gateway: GatewayPort, profile: MobileProfile, target: 'all' | 'memory' | 'user', signal?: AbortSignal): Promise<{ deleted: string[]; ok: boolean }> {
    requireDefaultProfileForMemoryRoute(profile)
    return request(gateway, '/api/memory/reset', { body: { target }, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  memoryOAuthStatus(gateway: GatewayPort, profile: MobileProfile, provider: string, signal?: AbortSignal): Promise<MemoryProviderOAuthStatus> {
    return request(gateway, profilePath(`/api/memory/providers/${encodeURIComponent(provider)}/oauth/status`, profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  startMemoryOAuth(gateway: GatewayPort, profile: MobileProfile, provider: string, signal?: AbortSignal): Promise<MemoryProviderOAuthStatus> {
    return request(gateway, profilePath(`/api/memory/providers/${encodeURIComponent(provider)}/oauth/start`, profile), { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  billingState(gateway: GatewayPort, _profile: MobileProfile, signal?: AbortSignal): Promise<BillingStateResponse> {
    // The billing RPC is account-wide and explicitly has no profile scope.
    return gateway.rpc<BillingStateResponse>('billing.state', {}, { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  subscriptionState(gateway: GatewayPort, _profile: MobileProfile, signal?: AbortSignal): Promise<SubscriptionStateResponse> {
    // The subscription RPC is account-wide and explicitly has no profile scope.
    return gateway.rpc<SubscriptionStateResponse>('subscription.state', {}, { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  elevenLabsVoices(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<{ available: boolean; voices: Array<{ label: string; name: string; voice_id: string }> }> {
    return request(gateway, profilePath('/api/audio/elevenlabs/voices', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  status(gateway: GatewayPort, _profile: MobileProfile, signal?: AbortSignal): Promise<Record<string, unknown>> {
    // /api/status is the machine-level liveness probe; profile query
    // parameters are ignored by the gateway and must not imply profile data.
    return request(gateway, '/api/status', { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  env(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<Record<string, EnvVarInfo>> {
    return request(gateway, profilePath('/api/env', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  setEnv(gateway: GatewayPort, profile: MobileProfile, key: string, value: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, profilePath('/api/env', profile), { body: { key, profile: profileKey(profile), value }, method: 'PUT', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  deleteEnv(gateway: GatewayPort, profile: MobileProfile, key: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, profilePath('/api/env', profile), { body: { key, profile: profileKey(profile) }, method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  revealEnv(gateway: GatewayPort, profile: MobileProfile, key: string, signal?: AbortSignal): Promise<{ key: string; value: string }> {
    return request(gateway, profilePath('/api/env/reveal', profile), { body: { key, profile: profileKey(profile) }, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  validateProvider(gateway: GatewayPort, profile: MobileProfile, key: string, value: string, apiKey = '', signal?: AbortSignal): Promise<{ message: string; models?: string[]; ok: boolean; reachable: boolean }> {
    return request(gateway, profilePath('/api/providers/validate', profile), { body: { api_key: apiKey, key, profile: profileKey(profile), value }, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  oauthProviders(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<OAuthProvidersResponse> {
    return request(gateway, profilePath('/api/providers/oauth', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  oauthStart(gateway: GatewayPort, profile: MobileProfile, provider: string, signal?: AbortSignal): Promise<OAuthStartResponse> {
    return request(gateway, profilePath(`/api/providers/oauth/${encodeURIComponent(provider)}/start`, profile), { body: {}, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  oauthPoll(gateway: GatewayPort, _profile: MobileProfile, provider: string, sessionId: string, signal?: AbortSignal): Promise<OAuthPollResponse> {
    // Polling reads the process-global in-memory flow registry; the opaque
    // session id, not a profile query, identifies the flow.
    return request(gateway, `/api/providers/oauth/${encodeURIComponent(provider)}/poll/${encodeURIComponent(sessionId)}`, { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  oauthSubmit(gateway: GatewayPort, profile: MobileProfile, provider: string, sessionId: string, code: string, signal?: AbortSignal): Promise<{ message?: string; ok: boolean; status: 'approved' | 'error' }> {
    return request(gateway, profilePath(`/api/providers/oauth/${encodeURIComponent(provider)}/submit`, profile), { body: { session_id: sessionId, code }, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  oauthCancel(gateway: GatewayPort, _profile: MobileProfile, sessionId: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, `/api/providers/oauth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  customEndpoints(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<CustomEndpointsResponse> {
    return request(gateway, profilePath('/api/providers/custom-endpoints', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  saveCustomEndpoint(gateway: GatewayPort, profile: MobileProfile, endpoint: CustomEndpointUpdate, signal?: AbortSignal): Promise<CustomEndpointsResponse> {
    return request(gateway, profilePath('/api/providers/custom-endpoints', profile), { body: endpoint, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  deleteCustomEndpoint(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<CustomEndpointsResponse> {
    return request(gateway, profilePath(`/api/providers/custom-endpoints/${encodeURIComponent(id)}`, profile), { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  activateCustomEndpoint(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<{ model: string; ok: boolean; provider: string }> {
    return request(gateway, profilePath(`/api/providers/custom-endpoints/${encodeURIComponent(id)}/activate`, profile), { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  validateCustomEndpoint(gateway: GatewayPort, profile: MobileProfile, body: CustomEndpointUpdate, signal?: AbortSignal): Promise<{ message: string; models: string[]; ok: boolean; reachable: boolean }> {
    return request(gateway, profilePath('/api/providers/custom-endpoints/validate', profile), { body, method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  sessions(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<{ sessions: Array<{ archived?: boolean; id: string; last_active?: number; message_count?: number; preview?: string; title?: string }> }> {
    return request(gateway, profilePath('/api/sessions?archived=only&limit=100&order=recent', profile), { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  restoreSession(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<void> {
    return request(gateway, profilePath(`/api/sessions/${encodeURIComponent(id)}`, profile), { body: { archived: false }, method: 'PATCH', signal, timeoutMs: SETTINGS_TIMEOUT_MS }).then(() => undefined)
  },
  deleteSession(gateway: GatewayPort, profile: MobileProfile, id: string, signal?: AbortSignal): Promise<void> {
    return request(gateway, profilePath(`/api/sessions/${encodeURIComponent(id)}`, profile), { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS }).then(() => undefined)
  },
  pluginsHub(gateway: GatewayPort, profile: MobileProfile, signal?: AbortSignal): Promise<{ plugins: Array<{ can_remove?: boolean; description?: string; name: string; runtime_status?: string; source?: string; version?: string }>; providers?: Record<string, unknown> }> {
    requireDefaultProfileForPluginRoute(profile)
    return request(gateway, '/api/dashboard/plugins/hub', { signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  pluginAction(gateway: GatewayPort, profile: MobileProfile, name: string, action: 'disable' | 'enable', signal?: AbortSignal): Promise<{ ok: boolean }> {
    requireDefaultProfileForPluginRoute(profile)
    return request(gateway, `/api/dashboard/agent-plugins/${name.split('/').map(encodeURIComponent).join('/')}/${action}`, { method: 'POST', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  },
  removePlugin(gateway: GatewayPort, profile: MobileProfile, name: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    requireDefaultProfileForPluginRoute(profile)
    return request(gateway, `/api/dashboard/agent-plugins/${name.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE', signal, timeoutMs: SETTINGS_TIMEOUT_MS })
  }
}
