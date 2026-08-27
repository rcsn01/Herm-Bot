import type { GatewayPort } from './gateway-port'
import { classifyGatewayError } from './gateway-error'

export interface RemoteActionState<T = unknown> {
  error?: unknown
  result?: T
  status: string
}

export interface RemoteActionOptions<T> {
  gateway: GatewayPort
  getScopeEpoch?: () => number
  intervalMs?: number
  isComplete?: (state: RemoteActionState<T>) => boolean
  maxAttempts?: number
  maxIntervalMs?: number
  maxNetworkErrors?: number
  poll: (gateway: GatewayPort, signal: AbortSignal) => Promise<RemoteActionState<T>>
  signal?: AbortSignal
  start: (gateway: GatewayPort, signal: AbortSignal) => Promise<RemoteActionState<T>>
}

const DEFAULT_TERMINAL = new Set(['complete', 'completed', 'failed', 'cancelled', 'canceled'])

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const aborted = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
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
  const epoch = options.getScopeEpoch?.()
  const assertScope = () => {
    controller.signal.throwIfAborted()
    if (epoch !== undefined && options.getScopeEpoch?.() !== epoch) throw new DOMException('Gateway scope changed.', 'AbortError')
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
