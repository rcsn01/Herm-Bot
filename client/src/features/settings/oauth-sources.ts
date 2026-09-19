import type { GatewayPort } from '~/gateway/gateway-port'
import type { OAuthFlowAdapter, OAuthFlowSnapshot } from '~/gateway/oauth-flow'
import type { MemoryProviderOAuthStatus, OAuthPollResponse, OAuthStartResponse } from '~/lib/types'

import type { SettingsApi } from './settings-api'

const providerPolling = { intervalMs: 1_000, maxAttempts: 60, maxIntervalMs: 5_000 } as const
const memoryPolling = { intervalMs: 2_000, maxAttempts: 60, maxIntervalMs: 10_000 } as const

type ProviderOAuthApi = Pick<SettingsApi, 'oauthPoll' | 'oauthStart'>
type MemoryOAuthApi = Pick<SettingsApi, 'memoryOAuthStatus' | 'startMemoryOAuth'>

function requiredString(value: unknown, field: string, protocol: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The gateway returned an invalid ${protocol} OAuth flow: missing ${field}.`)
  return value
}

function mapProviderStart(response: OAuthStartResponse): OAuthFlowSnapshot {
  const flowId = requiredString(response.session_id, 'session id', 'provider')
  const authorizationURL = 'auth_url' in response ? response.auth_url : response.verification_url
  const url = requiredString(authorizationURL, 'authorization URL', 'provider')
  const userCode = 'user_code' in response ? requiredString(response.user_code, 'user code', 'provider') : undefined
  return {
    authorizationURL: url,
    flowId,
    phase: 'waiting',
    ...(userCode ? { userCode } : {})
  }
}

function mapProviderPoll(response: OAuthPollResponse): OAuthFlowSnapshot {
  const phase = response.status === 'pending' ? 'waiting' : response.status
  return {
    flowId: requiredString(response.session_id, 'session id', 'provider'),
    message: response.error_message ?? undefined,
    phase
  }
}

export function createProviderOAuthAdapter(settings: ProviderOAuthApi, gateway: GatewayPort, provider: string): OAuthFlowAdapter {
  return {
    gateway,
    polling: providerPolling,
    poll: async (current, signal) => {
      const flowId = requiredString(current.flowId, 'session id', 'provider')
      return mapProviderPoll(await settings.oauthPoll(provider, flowId, signal))
    },
    start: async signal => mapProviderStart(await settings.oauthStart(provider, signal))
  }
}

function mapMemoryStatus(response: MemoryProviderOAuthStatus): OAuthFlowSnapshot {
  if (response.state === 'connected') return { phase: 'approved' }
  if (response.state === 'pending') return { phase: 'waiting' }
  if (response.state === 'error') return { message: response.detail || 'The memory provider rejected authorization.', phase: 'error' }
  return { message: response.detail || 'The gateway did not start memory provider authorization.', phase: 'error' }
}

export function createMemoryOAuthAdapter(settings: MemoryOAuthApi, gateway: GatewayPort, provider: string): OAuthFlowAdapter {
  return {
    gateway,
    polling: memoryPolling,
    poll: async (_current, signal) => mapMemoryStatus(await settings.memoryOAuthStatus(provider, signal)),
    start: async signal => mapMemoryStatus(await settings.startMemoryOAuth(provider, signal))
  }
}
