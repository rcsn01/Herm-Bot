import type { GatewayPort } from '~/gateway/gateway-port'
import { profileKey, profilePath } from '~/gateway/profile-path'
import { assertRemoteActionStart, remoteActionName, runRemoteAction, type RemoteActionState } from '~/gateway/remote-action'
import type { ActionStartResponse, ActionStatusResponse } from './skills-api'

export interface McpServerSummary {
  args: string[]
  auth?: string | null
  command: string | null
  enabled: boolean
  name: string
  tools: string[] | null
  transport: string
  url: string | null
}

export interface McpServerConfig {
  args?: string[]
  auth?: string
  command?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  url?: string
  [key: string]: unknown
}

export interface McpTestResult {
  error?: string
  ok: boolean
  prompts?: number
  resources?: number
  tools: Array<{ description: string; name: string; schema_chars?: number }>
}

export interface McpCatalogEntry {
  args: string[]
  auth_type: string
  bootstrap: string[]
  command: string | null
  default_enabled: string[] | null
  description: string
  enabled: boolean
  install_ref: string | null
  install_url: string | null
  installed: boolean
  name: string
  needs_install: boolean
  post_install: string
  required_env: Array<{ name: string; prompt: string; required: boolean }>
  transport: string
  url: string | null
}

export interface McpCatalogResponse {
  diagnostics: Array<{ kind: string; message: string; name: string }>
  entries: McpCatalogEntry[]
}

export interface McpOAuthFlow {
  authorization_url: string | null
  error: string | null
  flow_id: string
  server_name: string
  status: 'approved' | 'authorization_required' | 'error' | 'starting'
  tools?: Array<{ description: string; name: string }>
}

async function request<T>(gateway: GatewayPort, path: string, options: { body?: unknown; method?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  return (await gateway.request<T>({ ...options, path })).body
}

// Config responses are JSON-shaped, but iOS 15.0–15.3 WebViews do not
// consistently expose structuredClone. Keep the copy local and explicit so an
// update cannot mutate the query response while preserving unknown nested keys.
function cloneMcpConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneMcpConfig)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, cloneMcpConfig(nested)]))
  }
  return value
}

export const mcpApi = {
  list(gateway: GatewayPort, profile: null | string, signal?: AbortSignal): Promise<{ servers: McpServerSummary[] }> {
    return request(gateway, profilePath('/api/mcp/servers', profile), { signal })
  },

  /** The config endpoint is the authoritative editable map. Summary rows are redacted. */
  config(gateway: GatewayPort, profile: null | string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return request(gateway, profilePath('/api/config', profile), { signal })
  },

  add(gateway: GatewayPort, profile: null | string, body: { args?: string[]; auth?: string; command?: string; env?: Record<string, string>; name: string; url?: string }, signal?: AbortSignal): Promise<McpServerSummary> {
    return request(gateway, profilePath('/api/mcp/servers', profile), { body: { ...body, profile: profileKey(profile) }, method: 'POST', signal })
  },

  replace(gateway: GatewayPort, profile: null | string, servers: Record<string, McpServerConfig>, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, profilePath('/api/mcp/servers', profile), { body: { profile: profileKey(profile), servers }, method: 'PUT', signal })
  },

  async update(gateway: GatewayPort, profile: null | string, name: string, patch: McpServerConfig, signal?: AbortSignal): Promise<{ ok: boolean }> {
    const config = await this.config(gateway, profile, signal)
    const current = config.mcp_servers
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('The gateway returned no editable MCP server map.')
    const servers = cloneMcpConfig(current) as Record<string, McpServerConfig>
    servers[name] = { ...(servers[name] ?? {}), ...patch }
    return this.replace(gateway, profile, servers, signal)
  },

  remove(gateway: GatewayPort, profile: null | string, name: string, signal?: AbortSignal): Promise<{ ok: boolean }> {
    return request(gateway, profilePath(`/api/mcp/servers/${encodeURIComponent(name)}`, profile), { method: 'DELETE', signal })
  },

  toggle(gateway: GatewayPort, profile: null | string, name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }> {
    return request(gateway, profilePath(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, profile), { body: { enabled, profile: profileKey(profile) }, method: 'PUT', signal })
  },

  test(gateway: GatewayPort, profile: null | string, name: string, signal?: AbortSignal): Promise<McpTestResult> {
    return request(gateway, profilePath(`/api/mcp/servers/${encodeURIComponent(name)}/test`, profile), { method: 'POST', signal, timeoutMs: 60_000 })
  },

  catalog(gateway: GatewayPort, profile: null | string, signal?: AbortSignal): Promise<McpCatalogResponse> {
    return request(gateway, profilePath('/api/mcp/catalog', profile), { signal, timeoutMs: 60_000 })
  },

  installCatalog(gateway: GatewayPort, profile: null | string, name: string, env: Record<string, string> = {}, signal?: AbortSignal): Promise<ActionStartResponse & { background?: boolean }> {
    return request(gateway, profilePath('/api/mcp/catalog/install', profile), { body: { enable: true, env, name, profile: profileKey(profile) }, method: 'POST', signal, timeoutMs: 60_000 })
  },

  auth(gateway: GatewayPort, profile: null | string, name: string, signal?: AbortSignal): Promise<McpOAuthFlow> {
    return request(gateway, profilePath(`/api/mcp/servers/${encodeURIComponent(name)}/auth`, profile), { method: 'POST', signal, timeoutMs: 60_000 })
  },

  oauthStatus(gateway: GatewayPort, _profile: null | string, flowId: string, signal?: AbortSignal): Promise<McpOAuthFlow> {
    // OAuth flow state is held by the gateway process; this endpoint has no
    // profile parameter. The opaque flow id is the scope returned by auth().
    return request(gateway, `/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { signal, timeoutMs: 60_000 })
  },

  cancelOAuth(gateway: GatewayPort, _profile: null | string, flowId: string, signal?: AbortSignal): Promise<{ ok: boolean; status: string }> {
    return request(gateway, `/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE', signal })
  }
}

export function mcpActionStatus(gateway: GatewayPort, _profile: null | string, name: string, signal?: AbortSignal): Promise<ActionStatusResponse> {
  return request(gateway, `/api/actions/${encodeURIComponent(name)}/status`, { signal })
}

export async function runMcpInstallAction(
  gateway: GatewayPort,
  profile: null | string,
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
      const status = await mcpActionStatus(gateway, profile, action, pollSignal)
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
