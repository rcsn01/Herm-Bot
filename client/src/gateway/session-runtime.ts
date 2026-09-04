import type { GatewayEvent } from '@hermes/shared'

import { classifyGatewayError, GatewayError } from '~/gateway/gateway-error'
import { abortError, combineSignals, throwIfAborted } from './abort'
import { profileKey, profilePath } from './profile-path'
import type { GatewayPort, GatewayRequestOptions, GatewayUploadOptions } from '~/gateway/gateway-port'
import type { ChatState, SessionMessage, TranscriptMessage } from '~/lib/types'

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

export interface TranscriptPage {
  hasMore: boolean
  messages: TranscriptMessage[]
  nextOffset: number
}

export const TRANSCRIPT_PAGE_SIZE = 80

export interface RuntimeSession {
  contractVersion: number | null
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
      source: 'ios'
    }))
  }

  async resumeSession(profile: null | string, storedSessionId: string): Promise<RuntimeSession> {
    return this.sessionFromResponse(await this.rpc<SessionRPCResponse>('session.resume', {
      defer_history: true,
      omit_messages: true,
      profile: profileKey(profile),
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

  async historyPage(storedSessionId: string, profile: null | string, offset = 0): Promise<TranscriptPage> {
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
      messages: toTranscript(pagination ? rawMessages : rawMessages.slice(-TRANSCRIPT_PAGE_SIZE)),
      nextOffset: pageOffset + returned
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
      const response = await this.transport.rpc<SessionRPCResponse>('session.create', { profile: profileKey(profile), source: 'ios' }, { signal: operation.signal })
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
        source: 'ios'
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
      info: info as ChatState['info'],
      messages: toTranscript(response.messages?.slice(-TRANSCRIPT_PAGE_SIZE)),
      runtimeSessionId: response.session_id,
      storedSessionId
    }
  }
}

export function toTranscript(messages: SessionMessage[] = []): TranscriptMessage[] {
  return messages.flatMap((message, index) => {
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
    const storedRole = (['assistant', 'system', 'tool', 'user'].includes(message.role) ? message.role : 'assistant') as TranscriptMessage['role']
    const contentValue = projected.display_content !== undefined
      ? projected.display_content
      : projected.content ?? projected.text ?? (storedRole === 'tool' ? projected.context ?? projected.name : undefined)
    const rawContent = typeof contentValue === 'string' ? contentValue : ''
    const displayKind = typeof projected.display_kind === 'string'
      ? projected.display_kind
      : inferLegacyDisplayKind(storedRole, rawContent)
    if (displayKind === 'hidden') return []

    const rowIdValue = projected.row_id ?? projected.id
    const rowId = typeof rowIdValue === 'number' && Number.isInteger(rowIdValue) ? rowIdValue : undefined
    const reasoningValue = projected.reasoning ?? projected.reasoning_content
    const timelineContent = timelineDisplayContent(displayKind, projected.display_metadata, rawContent)

    return [{
      content: timelineContent ?? rawContent,
      ...(timelineContent === null ? {} : { displayKind }),
      id: rowId === undefined ? `history-${index}` : `history-row-${rowId}`,
      reasoning: typeof reasoningValue === 'string' ? reasoningValue : undefined,
      role: timelineContent === null ? storedRole : 'system',
      ...(rowId === undefined ? {} : { rowId }),
      streaming: false
    }]
  })
}

function inferLegacyDisplayKind(role: TranscriptMessage['role'], content: string): string | undefined {
  if (role !== 'user') return undefined
  if (/^\[ASYNC DELEGATION (?:BATCH )?COMPLETE\s+[—-]\s+deleg_[^\]\n]+\]\s*\nA background (?:fan-out|subagent)\b/.test(content)) {
    return 'async_delegation_complete'
  }
  return undefined
}

function timelineDisplayContent(displayKind: string | undefined, metadata: SessionMessage['display_metadata'], content = ''): string | null {
  if (displayKind === 'model_switch') return 'model changed'
  if (displayKind === 'auto_continue') return 'resumed interrupted turn'
  if (displayKind === 'personality_switch') return 'personality changed'
  if (displayKind !== 'async_delegation_complete') return null

  const parsed = parseDisplayMetadata(metadata)
  const countFromMetadata = parsed && typeof parsed.task_count === 'number' ? parsed.task_count : undefined
  const countFromLegacyText = content.match(/A background fan-out of (\d+) subagent\(s\)/)?.[1]
  const count = countFromMetadata ?? (countFromLegacyText ? Number(countFromLegacyText) : content.startsWith('[ASYNC DELEGATION COMPLETE ') ? 1 : undefined)
  return count === undefined ? 'background agent work finished' : `${count} background agent${count === 1 ? '' : 's'} finished`
}

function parseDisplayMetadata(metadata: SessionMessage['display_metadata']): Record<string, unknown> | null {
  let parsed: unknown = metadata
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
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
