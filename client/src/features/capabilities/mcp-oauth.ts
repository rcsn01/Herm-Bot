import type { GatewayPort } from '~/gateway/gateway-port'
import type { OAuthFlowAdapter, OAuthFlowSnapshot } from '~/gateway/oauth-flow'

import type { McpApi, McpOAuthFlow } from './mcp-api'

const mcpPolling = { intervalMs: 1_000, maxAttempts: 60, maxIntervalMs: 5_000 } as const

type McpOAuthApi = Pick<McpApi, 'auth' | 'oauthStatus'>

function requiredFlowId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('The gateway returned an invalid MCP OAuth flow: missing flow id.')
  return value
}

function mapMcpFlow(response: McpOAuthFlow, fallbackFlowId?: string): OAuthFlowSnapshot {
  const flowId = requiredFlowId(response.flow_id || fallbackFlowId)
  const phase = response.status === 'starting' || response.status === 'authorization_required' ? 'waiting' : response.status
  return {
    ...(response.authorization_url ? { authorizationURL: response.authorization_url } : {}),
    flowId,
    ...(response.error ? { message: response.error } : {}),
    phase
  }
}

export function createMcpOAuthAdapter(mcp: McpOAuthApi, gateway: GatewayPort, serverName: string): OAuthFlowAdapter {
  return {
    gateway,
    polling: mcpPolling,
    poll: async (current, signal) => {
      const flowId = requiredFlowId(current.flowId)
      return mapMcpFlow(await mcp.oauthStatus(flowId, signal), flowId)
    },
    start: async signal => mapMcpFlow(await mcp.auth(serverName, signal))
  }
}
