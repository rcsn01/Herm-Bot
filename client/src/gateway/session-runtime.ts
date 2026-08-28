import type { GatewayEvent } from '@hermes/shared'

import { classifyGatewayError, GatewayError } from '~/gateway/gateway-error'
import type { GatewayPort, GatewayRequestOptions, GatewayUploadOptions } from '~/gateway/gateway-port'
import type { ChatState, SessionMessage, TranscriptMessage } from '~/lib/types'

interface SessionRPCResponse {
  info?: Record<string, unknown>
  messages?: SessionMessage[]
  session_id: string
  stored_session_id?: string
}

interface SessionHistoryResponse {
  messages: SessionMessage[]
}

export interface RuntimeSession {
  contractVersion: number
  info: ChatState['info']
  messages: TranscriptMessage[]
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
}

const abortError = (message = 'Gateway scope changed.') => new DOMException(message, 'AbortError')

export class SessionRuntime implements GatewayPort {
  private scopeController = new AbortController()
  private generation = 0
  private disposed = false

  constructor(
    private readonly transport: GatewayPort,
    private readonly options: SessionRuntimeOptions
  ) {}

  subscribe(handler: (event: GatewayEvent) => void): () => void {
    return this.transport.subscribe(handler)
  }

  subscribeState(handler: (state: string) => void): () => void {
    return this.transport.subscribeState(handler)
  }

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

  async connect(profile?: null | string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.transport.connect(profile, options)
  }

  close(): void {
    this.closeScope()
  }

  async upload<T>(options: GatewayUploadOptions) {
    const operation = this.currentOperation()
    const signal = anySignal(operation.signal, options.signal)
    try {
      const result = await this.transport.upload<T>({ ...options, signal })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  async createSession(profile: null | string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.create', {
      profile,
      source: 'ios'
    }))
  }

  async resumeSession(profile: null | string, storedSessionId: string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.resume', {
      profile,
      session_id: storedSessionId,
      source: 'ios'
    }))
  }

  async branchSession(runtimeSessionId: string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.branch', { session_id: runtimeSessionId }))
  }

  async history(runtimeSessionId: string): Promise<TranscriptMessage[]> {
    const response = await this.rpc<SessionHistoryResponse>('session.history', { session_id: runtimeSessionId })
    return toTranscript(response.messages)
  }

  async rpc<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<T> {
    const operation = this.currentOperation()
    const signal = anySignal(operation.signal, options.signal)
    try {
      const result = await this.transport.rpc<T>(method, params, { signal, timeoutMs: options.timeoutMs })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  async request<T>(options: GatewayRequestOptions) {
    const operation = this.currentOperation()
    const signal = anySignal(operation.signal, options.signal)
    try {
      const result = await this.transport.request<T>({ ...options, signal })
      this.assertCurrent(operation)
      return result
    } catch (error) {
      throw classifyGatewayError(error)
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
    operation.signal.throwIfAborted()
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
      const response = await this.transport.rpc<SessionRPCResponse>('session.create', { profile, source: 'ios' }, { signal: operation.signal })
      this.assertCurrent(operation)
      return this.sessionFromResponse(response)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  private async resumeCurrent(profile: null | string, storedSessionId: string, operation: { generation: number; signal: AbortSignal }): Promise<RuntimeSession> {
    try {
      const response = await this.transport.rpc<SessionRPCResponse>('session.resume', {
        profile,
        session_id: storedSessionId,
        source: 'ios'
      }, { signal: operation.signal })
      this.assertCurrent(operation)
      return this.sessionFromResponse(response)
    } catch (error) {
      throw classifyGatewayError(error)
    }
  }

  private sessionFromResponse(response: SessionRPCResponse): RuntimeSession {
    const info = response.info ?? {}
    const version = Number(info.desktop_contract ?? 0)
    if (!Number.isFinite(version) || version < this.options.minimumContract) {
      this.transport.close()
      throw new GatewayError(
        `This remote Hermes is too old for Hermes Mobile. Update the remote gateway (contract ${this.options.minimumContract} or newer).`,
        { code: 'MOBILE_CONTRACT_UNSUPPORTED', kind: 'unsupported', retryable: false }
      )
    }
    const storedSessionId = (response.stored_session_id ?? String(info.stored_session_id ?? '')) || null
    return {
      contractVersion: version,
      info: info as ChatState['info'],
      messages: toTranscript(response.messages),
      runtimeSessionId: response.session_id,
      storedSessionId
    }
  }
}

export function toTranscript(messages: SessionMessage[] = []): TranscriptMessage[] {
  return messages.map((message, index) => {
    const projected = message as SessionMessage & {
      context?: unknown
      display_content?: unknown
      id?: unknown
      name?: unknown
      reasoning?: unknown
      reasoning_content?: unknown
      row_id?: unknown
      text?: unknown
    }
    const role = (['assistant', 'system', 'tool', 'user'].includes(message.role) ? message.role : 'assistant') as TranscriptMessage['role']
    const contentValue = projected.display_content !== undefined
      ? projected.display_content
      : projected.content ?? projected.text ?? (role === 'tool' ? projected.context ?? projected.name : undefined)
    const rowIdValue = projected.row_id ?? projected.id
    const rowId = typeof rowIdValue === 'number' && Number.isInteger(rowIdValue) ? rowIdValue : undefined
    const reasoningValue = projected.reasoning ?? projected.reasoning_content

    return {
      content: typeof contentValue === 'string' ? contentValue : '',
      id: rowId === undefined ? `history-${index}` : `history-row-${rowId}`,
      reasoning: typeof reasoningValue === 'string' ? reasoningValue : undefined,
      role,
      ...(rowId === undefined ? {} : { rowId }),
      streaming: false
    }
  })
}

function isConfirmedMissingSession(error: GatewayError): boolean {
  const code = String(error.code ?? '').toUpperCase()
  if (code === 'SESSION_NOT_FOUND') return true
  if (error.kind !== 'server' && error.kind !== 'unsupported') return false
  const message = error.message.trim()
  return /^(?:stored )?session not found[.!]?$/i.test(message) || /^no session found with id\b/i.test(message)
}

function anySignal(primary: AbortSignal, secondary?: AbortSignal): AbortSignal {
  if (!secondary) return primary
  return AbortSignal.any([primary, secondary])
}

function wait(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, delay)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer)
      reject(signal.reason ?? abortError())
    }, { once: true })
  })
}
