import type { GatewayPort } from './gateway-port'
import { GatewayError } from './gateway-error'
import { profileKey, type MobileProfile } from './profile-path'

export interface GatewayApiRequestOptions {
  body?: unknown
  method?: string
  /** Extra query params merged ahead of the profile param (undefined dropped). */
  params?: Record<string, string | number | undefined>
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GatewayApiRpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * A GatewayPort bound to one Profile. Owns, once and for every feature API:
 * profile-path derivation on scoped routes, response unwrapping, the
 * deliberately-unscoped route tier, and the default-profile gate.
 *
 * Delegation only: every method forwards to the GatewayPort — no retries, no
 * caching, no Scope capture, no error classification. The GatewaySession
 * (SessionRuntime) already combines signals, aborts stale-Scope work, and
 * classifies errors; this module must never re-implement or bypass that.
 * Route strings, verbs, bodies, timeouts, and gate messages stay in the
 * feature API factories.
 */
export interface GatewayApi {
  /** Escape hatch — for runRemoteAction and native upload paths ONLY.
   *  Feature routes must go through request/unscoped/defaultOnly. */
  readonly gateway: GatewayPort
  /** Wire key ('default' when the UI profile is null) for routes that demand profile IN THE BODY. */
  readonly profileKey: string
  /** Gate predicate for UI enabling (null profile counts as default). */
  readonly isDefaultProfile: boolean
  /** Profile-scoped route: appends exactly one ?profile=<key>; unwraps .body. The default tier. */
  request<T>(path: string, options?: GatewayApiRequestOptions): Promise<T>
  /** Deliberately profile-blind route (process-global / account-wide by backend contract); never appends profile. */
  unscoped<T>(path: string, options?: GatewayApiRequestOptions): Promise<T>
  /** Default-profile-only process route: throws BEFORE any I/O unless the bound profile is default. */
  defaultOnly<T>(message: string, path: string, options?: GatewayApiRequestOptions): Promise<T>
  /** JSON-RPC passthrough (account/session RPCs are unscoped by definition). */
  rpc<T>(method: string, params?: Record<string, unknown>, options?: GatewayApiRpcOptions): Promise<T>
}

function mergeParams(path: string, params?: Record<string, string | number | undefined>): string {
  if (!params || Object.keys(params).length === 0) return path
  const url = new URL(path, 'http://hermes.mobile')
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}${url.hash}`
}

function finalizePath(path: string, wireKey?: string): string {
  if (wireKey === undefined) return path
  const url = new URL(path, 'http://hermes.mobile')
  url.searchParams.set('profile', wireKey)
  return `${url.pathname}${url.search}${url.hash}`
}

export function createGatewayApi(gateway: GatewayPort, profile: MobileProfile): GatewayApi {
  const wireKey = profileKey(profile)
  const isDefaultProfile = wireKey === 'default'
  const buildPath = (path: string, options?: GatewayApiRequestOptions, wireKeyOverride?: string): string =>
    finalizePath(mergeParams(path, options?.params), wireKeyOverride)

  const unscoped = <T>(path: string, options?: GatewayApiRequestOptions): Promise<T> =>
    gateway
      .request<T>({ ...unwrapOptions(options), path: buildPath(path, options) })
      .then(response => response.body)

  const defaultOnly = <T>(message: string, path: string, options?: GatewayApiRequestOptions): Promise<T> => {
    // Gate BEFORE any I/O; byte-identical to the deleted per-module helpers.
    if (!isDefaultProfile) {
      throw new GatewayError(message, {
        code: 'PROFILE_SCOPE_UNSUPPORTED',
        kind: 'unsupported',
        retryable: false
      })
    }
    return unscoped<T>(path, options)
  }

  return {
    gateway,
    profileKey: wireKey,
    isDefaultProfile,
    request<T>(path: string, options?: GatewayApiRequestOptions): Promise<T> {
      return gateway
        .request<T>({ ...unwrapOptions(options), path: buildPath(path, options, wireKey) })
        .then(response => response.body)
    },
    unscoped,
    defaultOnly,
    rpc<T>(method: string, params?: Record<string, unknown>, options?: GatewayApiRpcOptions): Promise<T> {
      return gateway.rpc<T>(method, params, { signal: options?.signal, timeoutMs: options?.timeoutMs })
    }
  }
}

function unwrapOptions(options?: GatewayApiRequestOptions) {
  return {
    body: options?.body,
    method: options?.method,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs
  }
}