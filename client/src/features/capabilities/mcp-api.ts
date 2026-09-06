import type { GatewayApi } from '~/gateway/gateway-api'
import type { RemoteActionStartResponse } from '~/gateway/remote-action'

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

export interface McpApi {
  list(signal?: AbortSignal): Promise<{ servers: McpServerSummary[] }>
  /** The config endpoint is the authoritative editable map. Summary rows are redacted. */
  config(signal?: AbortSignal): Promise<Record<string, unknown>>
  add(body: { args?: string[]; auth?: string; command?: string; env?: Record<string, string>; name: string; url?: string }, signal?: AbortSignal): Promise<McpServerSummary>
  replace(servers: Record<string, McpServerConfig>, signal?: AbortSignal): Promise<{ ok: boolean }>
  update(name: string, patch: McpServerConfig, signal?: AbortSignal): Promise<{ ok: boolean }>
  remove(name: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  toggle(name: string, enabled: boolean, signal?: AbortSignal): Promise<{ enabled: boolean; name: string; ok: boolean }>
  test(name: string, signal?: AbortSignal): Promise<McpTestResult>
  catalog(signal?: AbortSignal): Promise<McpCatalogResponse>
  installCatalog(name: string, env?: Record<string, string>, signal?: AbortSignal): Promise<RemoteActionStartResponse>
  auth(name: string, signal?: AbortSignal): Promise<McpOAuthFlow>
  oauthStatus(flowId: string, signal?: AbortSignal): Promise<McpOAuthFlow>
  cancelOAuth(flowId: string, signal?: AbortSignal): Promise<{ ok: boolean; status: string }>
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

export function createMcpApi(api: GatewayApi): McpApi {
  const mcp: McpApi = {
    list: (signal?: AbortSignal) => api.request('/api/mcp/servers', { signal }),
    config: (signal?: AbortSignal) => api.request('/api/config', { signal }),
    add: (body: { args?: string[]; auth?: string; command?: string; env?: Record<string, string>; name: string; url?: string }, signal?: AbortSignal) =>
      api.request('/api/mcp/servers', { body: { ...body, profile: api.profileKey }, method: 'POST', signal }),
    replace: (servers: Record<string, McpServerConfig>, signal?: AbortSignal) =>
      api.request('/api/mcp/servers', { body: { profile: api.profileKey, servers }, method: 'PUT', signal }),
    update: async (name: string, patch: McpServerConfig, signal?: AbortSignal) => {
      const config = await mcp.config(signal)
      const current = config.mcp_servers
      if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('The gateway returned no editable MCP server map.')
      const servers = cloneMcpConfig(current) as Record<string, McpServerConfig>
      servers[name] = { ...(servers[name] ?? {}), ...patch }
      return mcp.replace(servers, signal)
    },
    remove: (name: string, signal?: AbortSignal) =>
      api.request(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE', signal }),
    toggle: (name: string, enabled: boolean, signal?: AbortSignal) =>
      api.request(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, {
        body: { enabled, profile: api.profileKey },
        method: 'PUT',
        signal
      }),
    test: (name: string, signal?: AbortSignal) =>
      api.request(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST', signal, timeoutMs: 60_000 }),
    catalog: (signal?: AbortSignal) => api.request('/api/mcp/catalog', { signal, timeoutMs: 60_000 }),
    installCatalog: (name: string, env: Record<string, string> = {}, signal?: AbortSignal) =>
      api.request('/api/mcp/catalog/install', {
        body: { enable: true, env, name, profile: api.profileKey },
        method: 'POST',
        signal,
        timeoutMs: 60_000
      }),
    auth: (name: string, signal?: AbortSignal) =>
      api.request(`/api/mcp/servers/${encodeURIComponent(name)}/auth`, { method: 'POST', signal, timeoutMs: 60_000 }),
    oauthStatus: (flowId: string, signal?: AbortSignal) => {
      // OAuth flow state is held by the gateway process; this endpoint has no
      // profile parameter. The opaque flow id is the scope returned by auth().
      return api.unscoped(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { signal, timeoutMs: 60_000 })
    },
    cancelOAuth: (flowId: string, signal?: AbortSignal) =>
      api.unscoped(`/api/mcp/oauth/flows/${encodeURIComponent(flowId)}`, { method: 'DELETE', signal })
  }
  return mcp
}
