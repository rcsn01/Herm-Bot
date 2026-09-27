import { classifyGatewayError, GatewayError } from '~/gateway/gateway-error'
import { abortError, combineSignals, throwIfAborted } from './abort'
import { profileKey, profilePath } from './profile-path'
import type { GatewayPort, GatewayRequestOptions, GatewayTransport, GatewayUploadOptions } from '~/gateway/gateway-port'
import type { SessionMessage, SessionRuntimeInfo } from '~/compat/hermes-types'

interface SessionRPCResponse {
  info?: Record<string, unknown>
  messages?: SessionMessage[]
  session_id: string
  session_key?: string
  stored_session_id?: string
}

interface SessionHistoryResponse {
  messages: SessionMessage[]
}

interface SessionHistoryPageResponse {
  data?: SessionMessage[]
  messages?: SessionMessage[]
  pagination?: {
    limit?: number
    offset?: number
    returned?: number
  }
}

export interface SessionHistoryPage {
  hasMore: boolean
  nextOffset: number
  offset: number
  rows: SessionMessage[]
}

export const TRANSCRIPT_PAGE_SIZE = 80

export interface RuntimeSession {
  contractVersion: number | null
  info: SessionRuntimeInfo
  rows: SessionMessage[]
  runtimeSessionId: string
  storedSessionId: null | string
}

export interface OpenSessionResult<T = void> {
  preparation: T
  resumed: boolean
  session: RuntimeSession
}

export interface OpenSessionOptions {
  profile: null | string
  storedSessionId: null | string
}

export interface SessionRuntimeOptions {
  minimumContract: number
  retryDelays: readonly number[]
  sessionSource?: string
}

export class SessionRuntime implements GatewayPort {
  private scopeController = new AbortController()
  private generation = 0
  private disposed = false

  constructor(
    private readonly transport: GatewayTransport,
    private readonly options: SessionRuntimeOptions
  ) {}

  async open<T = void>(
    options: OpenSessionOptions,
    prepare?: (signal: AbortSignal) => Promise<T>
  ): Promise<OpenSessionResult<T>> {
    const operation = this.beginScope()
    let preparation: T
    try {
      preparation = prepare ? await prepare(operation.signal) : undefined as T
      this.assertCurrent(operation)
    } catch (error) {
      throw classifyGatewayError(error)
    }
    await this.connectCurrentScope(options.profile, operation)
    return { ...await this.restoreOrCreate(options, operation), preparation }
  }

  async reopen(options: OpenSessionOptions): Promise<OpenSessionResult> {
    const operation = this.beginScope()
    let lastError: GatewayError | undefined
    for (const delay of this.options.retryDelays) {
      try {
        if (delay) await wait(delay, operation.signal)
        await this.connectCurrentScope(options.profile, operation)
        return { ...await this.restoreOrCreate(options, operation), preparation: undefined }
      } catch (error) {
        const classified = classifyGatewayError(error)
        if (!classified.retryable) throw classified
        lastError = classified
        this.transport.close()
      }
    }
    throw lastError ?? new GatewayError('Gateway reconnect failed.', { kind: 'network' })
  }

  close(): void {
    this.closeScope()
  }

  async upload<T>(options: GatewayUploadOptions) {
    const operation = this.currentOperation()
    const combined = combineSignals(operation.signal, options.signal)
    try {
      const result = await this.transport.upload<T>({ ...options, signal: combined.signal })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    } finally {
      combined.cleanup()
    }
  }

  async createSession(profile: null | string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.create', {
      profile: profileKey(profile),
      source: this.options.sessionSource ?? 'ios'
    }))
  }

  async resumeSession(profile: null | string, storedSessionId: string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.resume', {
      defer_history: true,
      omit_messages: true,
      profile: profileKey(profile),
      session_id: storedSessionId,
      source: this.options.sessionSource ?? 'ios'
    }))
  }

  async branchSession(runtimeSessionId: string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.branch', { session_id: runtimeSessionId }))
  }

  async history(runtimeSessionId: string): Promise<SessionMessage[]> {
    const response = await this.rpc<SessionHistoryResponse>('session.history', { session_id: runtimeSessionId })
    return response.messages ?? []
  }

  async historyPage(storedSessionId: string, profile: null | string, offset = 0): Promise<SessionHistoryPage> {
    const query = new URLSearchParams({
      include_compacted: 'true',
      limit: String(TRANSCRIPT_PAGE_SIZE),
      offset: String(offset),
      order: 'latest'
    })
    const path = profilePath(`/api/sessions/${encodeURIComponent(storedSessionId)}/messages?${query}`, profile)
    const response = await this.request<SessionHistoryPageResponse>({ path })
    const rawMessages = response.body.messages ?? response.body.data ?? []
    const pagination = response.body.pagination
    const returned = pagination?.returned ?? rawMessages.length
    const limit = pagination?.limit ?? TRANSCRIPT_PAGE_SIZE
    const pageOffset = pagination?.offset ?? offset
    return {
      hasMore: Boolean(pagination) && returned >= limit,
      nextOffset: pageOffset + returned,
      offset: pageOffset,
      rows: pagination ? rawMessages : rawMessages.slice(-TRANSCRIPT_PAGE_SIZE)
    }
  }

  async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    const operation = this.currentOperation()
    const combined = combineSignals(operation.signal, options.signal)
    try {
      const result = await this.transport.rpc<T>(method, params, { signal: combined.signal, timeoutMs: options.timeoutMs })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    } finally {
      combined.cleanup()
    }
  }

  async request<T>(options: GatewayRequestOptions) {
    const operation = this.currentOperation()
    const combined = combineSignals(operation.signal, options.signal)
    try {
      const result = await this.transport.request<T>({ ...options, signal: combined.signal })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    } finally {
      combined.cleanup()
    }
  }

  closeScope(): void {
    this.generation += 1
    this.scopeController.abort(abortError())
    this.scopeController = new AbortController()
    this.transport.close()
  }

  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.scopeController.abort(abortError('Gateway runtime disposed.'))
    this.transport.close()
  }

  private beginScope() {
    this.disposed = false
    this.closeScope()
    return this.currentOperation()
  }

  private currentOperation() {
    if (this.disposed) throw abortError('Gateway runtime disposed.')
    return { generation: this.generation, signal: this.scopeController.signal }
  }

  private assertCurrent(operation: { generation: number; signal: AbortSignal }): void {
    throwIfAborted(operation.signal)
    if (operation.generation !== this.generation || this.disposed) throw abortError()
  }

  private async connectCurrentScope(profile: null | string, operation: { generation: number; signal: AbortSignal }): Promise<void> {
    try {
      await this.transport.connect(profile, { signal: operation.signal })
      this.assertCurrent(operation)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  private async restoreOrCreate(options: OpenSessionOptions, operation: { generation: number; signal: AbortSignal }): Promise<Omit<OpenSessionResult, 'preparation'>> {
    if (options.storedSessionId) {
      try {
        const session = await this.resumeCurrent(options.profile, options.storedSessionId, operation)
        return { resumed: true, session }
      } catch (error) {
        const classified = classifyGatewayError(error)
        if (!isConfirmedMissingSession(classified)) throw classified
      }
    }
    return { resumed: false, session: await this.createCurrent(options.profile, operation) }
  }

  private async createCurrent(profile: null | string, operation: { generation: number; signal: AbortSignal }): Promise<RuntimeSession> {
    try {
      const response = await this.transport.rpc<SessionRPCResponse>('session.create', { profile: profileKey(profile), source: this.options.sessionSource ?? 'ios' }, { signal: operation.signal })
      this.assertCurrent(operation)
      return this.sessionFromResponse(response)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  private async resumeCurrent(profile: null | string, storedSessionId: string, operation: { generation: number; signal: AbortSignal }): Promise<RuntimeSession> {
    try {
      const response = await this.transport.rpc<SessionRPCResponse>('session.resume', {
        defer_history: true,
        omit_messages: true,
        profile: profileKey(profile),
        session_id: storedSessionId,
        source: this.options.sessionSource ?? 'ios'
      }, { signal: operation.signal })
      this.assertCurrent(operation)
      return this.sessionFromResponse(response)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  private sessionFromResponse(response: SessionRPCResponse): RuntimeSession {
    if (typeof response.session_id !== 'string' || !response.session_id.trim()) {
      this.transport.close()
      throw new GatewayError('Remote Hermes returned an invalid session identity.', {
        kind: 'validation', retryable: false
      })
    }
    const info = response.info ?? {}
    const hasVersion = Object.prototype.hasOwnProperty.call(info, 'desktop_contract')
    const rawVersion = info.desktop_contract
    if (hasVersion && (typeof rawVersion !== 'number' || !Number.isFinite(rawVersion) || rawVersion < this.options.minimumContract)) {
      this.transport.close()
      throw new GatewayError(
        `This remote Hermes is too old for Hermes Mobile. Update the remote gateway (contract ${this.options.minimumContract} or newer).`,
        { code: 'MOBILE_CONTRACT_UNSUPPORTED', kind: 'unsupported', retryable: false }
      )
    }
    const storedSessionId = (response.stored_session_id ?? response.session_key ?? String(info.stored_session_id ?? '')) || null
    return {
      contractVersion: hasVersion ? rawVersion as number : null,
      info: info as SessionRuntimeInfo,
      rows: response.messages?.slice(-TRANSCRIPT_PAGE_SIZE) ?? [],
      runtimeSessionId: response.session_id,
      storedSessionId
    }
  }
}

export function isConfirmedMissingSession(error: GatewayError): boolean {
  const code = String(error.code ?? '').toUpperCase()
  if (code === 'SESSION_NOT_FOUND') return true
  if (error.kind !== 'server' && error.kind !== 'unsupported') return false
  const message = error.message.trim()
  return /^(?:stored )?session not found[.!]?$/i.test(message) || /^no session found with id\b/i.test(message)
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? abortError())
      return
    }
    const onAbort = () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? abortError())
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
