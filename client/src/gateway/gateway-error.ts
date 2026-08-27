import { JsonRpcGatewayError } from '@hermes/shared'

export type GatewayErrorKind = 'aborted' | 'auth' | 'conflict' | 'network' | 'server' | 'unsupported' | 'validation'

export interface GatewayErrorOptions {
  cause?: unknown
  code?: number | string
  details?: unknown
  kind: GatewayErrorKind
  retryable?: boolean
  status?: number
}

export class GatewayError extends Error {
  readonly code?: number | string
  readonly details?: unknown
  readonly kind: GatewayErrorKind
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: GatewayErrorOptions) {
    super(message, { cause: options.cause })
    this.name = 'GatewayError'
    this.code = options.code
    this.details = options.details
    this.kind = options.kind
    this.status = options.status
    this.retryable = options.retryable ?? (options.kind === 'network' || options.kind === 'server')
  }
}

interface ErrorShape {
  code?: number | string
  data?: unknown
  details?: unknown
  message?: string
  name?: string
  status?: number
}

export function classifyGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  const value = (error && typeof error === 'object' ? error : {}) as ErrorShape
  const message = value.message ?? String(error)
  const text = message.toLowerCase()
  const nestedStatus = value.data && typeof value.data === 'object' ? (value.data as { status?: unknown }).status : undefined
  const status = typeof value.status === 'number' ? value.status : typeof nestedStatus === 'number' ? nestedStatus : undefined
  const code = value.code
  const details = error instanceof JsonRpcGatewayError ? error.data : value.details ?? value.data

  if (value.name === 'AbortError' || code === 'ABORT_ERR') return new GatewayError(message, { cause: error, code, details, kind: 'aborted', retryable: false, status })
  if (status === 401 || status === 403 || code === 'AUTH_REQUIRED') return new GatewayError(message, { cause: error, code, details, kind: 'auth', retryable: false, status })
  if (status === 404 || code === -32_601 || /method not found|unsupported endpoint/.test(text)) return new GatewayError(message, { cause: error, code, details, kind: 'unsupported', retryable: false, status })
  if (status === 400 || status === 422 || code === -32_602) return new GatewayError(message, { cause: error, code, details, kind: 'validation', retryable: false, status })
  if (status === 409) return new GatewayError(message, { cause: error, code, details, kind: 'conflict', retryable: false, status })
  if (status !== undefined && status >= 500) return new GatewayError(message, { cause: error, code, details, kind: 'server', status })
  if (/timeout|timed out|network|websocket|disconnected|not connected|failed to fetch|could not reach|offline/.test(text) || code === 'ETIMEDOUT') return new GatewayError(message, { cause: error, code, details, kind: 'network', status })
  return new GatewayError(message, { cause: error, code, details, kind: 'server', retryable: false, status })
}

export const isTemporaryGatewayError = (error: unknown): boolean => classifyGatewayError(error).retryable
