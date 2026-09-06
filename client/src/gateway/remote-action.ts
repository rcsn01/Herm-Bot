import type { GatewayApi } from './gateway-api'
import type { GatewayPort } from './gateway-port'
import { abortError, throwIfAborted } from './abort'
import { classifyGatewayError, GatewayError } from './gateway-error'

export interface RemoteActionState<T = unknown> {
  error?: unknown
  result?: T
  status: string
}

export interface RemoteActionOptions<T> {
  gateway: GatewayPort
  /** Bound to the operation's starting Scope. False aborts further polling. */
  isCurrentScope?: () => boolean
  intervalMs?: number
  isComplete?: (state: RemoteActionState<T>) => boolean
  maxAttempts?: number
  maxIntervalMs?: number
  maxNetworkErrors?: number
  poll: (gateway: GatewayPort, signal: AbortSignal) => Promise<RemoteActionState<T>>
  signal?: AbortSignal
  start: (gateway: GatewayPort, signal: AbortSignal) => Promise<RemoteActionState<T>>
}

export interface RemoteActionStartResponse {
  action?: string
  background?: boolean
  error?: string
  message?: string
  name?: string
  ok?: boolean
}

/** Reject an explicit gateway refusal before a caller starts polling. */
export function assertRemoteActionStart<T extends RemoteActionStartResponse>(response: T): T {
  if (!response || typeof response !== 'object') throw new Error('The gateway returned an invalid remote-action response.')
  if (response.ok === false) throw new Error(response.error || response.message || 'The gateway could not start the remote action.')
  return response
}

/** Resolve the poll handle; synchronous actions are allowed not to return one. */
export function remoteActionName(response: RemoteActionStartResponse): string {
  const name = [response.action, response.name].find(value => typeof value === 'string' && value.trim())?.trim() ?? ''
  if (response.background !== false && !name) throw new Error('The gateway started a remote action without a poll handle.')
  return name
}

const DEFAULT_TERMINAL = new Set(['complete', 'completed', 'failed', 'cancelled', 'canceled'])

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason ?? abortError())
    }
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/** Runs and polls a remote action without allowing an old profile's result to land. */
export async function runRemoteAction<T>(options: RemoteActionOptions<T>): Promise<RemoteActionState<T>> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const assertScope = () => {
    throwIfAborted(controller.signal)
    if (options.isCurrentScope && !options.isCurrentScope()) throw abortError('Gateway scope changed.')
  }

  try {
    assertScope()
    let state = await options.start(options.gateway, controller.signal)
    const complete = options.isComplete ?? (candidate => DEFAULT_TERMINAL.has(candidate.status.toLowerCase()))
    let networkErrors = 0
    const maxAttempts = options.maxAttempts ?? 60
    const maxNetworkErrors = options.maxNetworkErrors ?? 3

    for (let attempt = 0; !complete(state) && attempt < maxAttempts; attempt += 1) {
      assertScope()
      const baseInterval = options.intervalMs ?? 1_000
      const pollInterval = Math.min(baseInterval * 2 ** Math.min(attempt, 4), options.maxIntervalMs ?? 15_000)
      await delay(pollInterval, controller.signal)
      assertScope()
      try {
        state = await options.poll(options.gateway, controller.signal)
        networkErrors = 0
      } catch (error) {
        const classified = classifyGatewayError(error)
        if (!classified.retryable || ++networkErrors > maxNetworkErrors) throw classified
      }
    }
    assertScope()
    if (!complete(state)) throw classifyGatewayError(new Error(`Remote action timed out after ${maxAttempts} polls.`))
    return state
  } finally {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

/** Status payload of the gateway's action routes — the protocol's result tier. */
export interface ActionStatusResponse {
  exit_code: number | null
  lines?: string[]
  pid?: number | null
  running: boolean
}

/** Terminal state of a gateway action; `result` is the final status payload. */
export type GatewayActionState = RemoteActionState<ActionStatusResponse>

export interface GatewayActionOptions {
  /** Bound to the operation's starting Scope. False aborts further polling. */
  isCurrentScope?: () => boolean
  /** Engine passthrough: first poll delay; defaults to the protocol cadence. */
  intervalMs?: number
  /** Engine passthrough: backoff ceiling; defaults to the protocol cadence. */
  maxIntervalMs?: number
  /** Poll bound for the action protocol; default 120. */
  maxAttempts?: number
  signal?: AbortSignal
  /** Start route (feature vocabulary). Returns the start response carrying the poll handle. */
  start: (signal: AbortSignal) => Promise<RemoteActionStartResponse>
}

const GATEWAY_ACTION_MAX_ATTEMPTS = 120

/** Runs one gateway action end to end: start → poll handle → status → terminal. */
export async function runGatewayAction(api: GatewayApi, options: GatewayActionOptions): Promise<GatewayActionState> {
  let handle = ''
  const state = await runRemoteAction<ActionStatusResponse>({
    gateway: api.gateway,
    intervalMs: options.intervalMs,
    isCurrentScope: options.isCurrentScope,
    maxAttempts: options.maxAttempts ?? GATEWAY_ACTION_MAX_ATTEMPTS,
    maxIntervalMs: options.maxIntervalMs,
    poll: async (_gateway, pollSignal) => {
      // Action status is owned by the dashboard process. The route has no
      // profile scope; the handle returned by the start endpoint is the
      // authoritative poll id.
      const status = await api.unscoped<ActionStatusResponse>(`/api/actions/${encodeURIComponent(handle)}/status`, { signal: pollSignal })
      return { result: status, status: status.running ? 'running' : status.exit_code === 0 ? 'complete' : 'failed' }
    },
    signal: options.signal,
    start: async (_gateway, startSignal) => {
      const response = assertRemoteActionStart(await options.start(startSignal))
      handle = remoteActionName(response)
      return { result: undefined, status: response.background === false ? 'complete' : 'running' }
    }
  })
  // A terminal failure is the caller's error, never a silent success: every
  // pre-protocol call site ignored the failed status.
  if (state.status === 'failed') {
    const status = state.result
    const exit = status?.exit_code != null ? ` (exit code ${status.exit_code})` : ''
    throw new GatewayError(`The gateway action failed${exit}.`, {
      code: 'ACTION_FAILED',
      details: status,
      kind: 'server',
      retryable: false
    })
  }
  return state
}
