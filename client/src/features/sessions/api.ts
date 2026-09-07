import type { GatewayApi } from '~/gateway/gateway-api'
import type { StoredSession } from '~/lib/types'

export interface SessionsApi {
  /** JSON-RPC session.list — profile in RPC params (RPCs are unscoped by wire, scoped by params). */
  list(limit: number, signal?: AbortSignal): Promise<{ sessions: StoredSession[] }>
  rename(id: string, title: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  archive(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  restore(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
  remove(id: string, signal?: AbortSignal, timeoutMs?: number): Promise<void>
}

export function createSessionsApi(api: GatewayApi): SessionsApi {
  return {
    list: (limit, signal) =>
      api.rpc<{ sessions: StoredSession[] }>('session.list', { limit, profile: api.profileKey }, { signal }),
    rename: (id, title, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { profile: api.profileKey, title }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    archive: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { archived: true, profile: api.profileKey }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    restore: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        body: { archived: false }, method: 'PATCH', signal, timeoutMs
      }).then(() => undefined),
    remove: (id, signal, timeoutMs) =>
      api.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE', signal, timeoutMs
      }).then(() => undefined)
  }
}