import { App } from '@capacitor/app'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '@hermes/shared'

import { clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import type { ChatState, SessionMessage, StoredSession, TranscriptMessage } from '~/lib/types'
import { HermesConnection, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetRoutes } from '~/navigation/navigation-store'
import { emptyChatState, reduceGatewayEvent } from '~/state/event-reducer'
import { $chat, $connection, $preferences, $sessions, savePreferences } from '~/state/store'

interface SessionRPCResponse {
  info?: Record<string, unknown>
  messages?: SessionMessage[]
  session_id: string
  stored_session_id?: string
}

interface SessionHistoryResponse {
  messages: SessionMessage[]
}

export const MINIMUM_CONTRACT = 6
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]

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

export class GatewayController {
  readonly gateway: RemoteGateway
  readonly client: RemoteGateway['client']
  private reconnectGeneration = 0
  private scopeEpoch = 0
  private lifecycleGeneration = 0
  private disposed = false
  private activeListener?: Awaited<ReturnType<typeof App.addListener>>

  constructor(private readonly connection: HermesConnectionPlugin = HermesConnection) {
    this.gateway = new RemoteGateway(connection)
    this.client = this.gateway.client
    this.gateway.subscribe(event => this.onEvent(event))
    this.client.onState(state => {
      if (state === 'closed' && !this.disposed && $connection.get().phase === 'connected') {
        $connection.set({ ...$connection.get(), phase: 'disconnected' })
      }
    })
  }

  async initialize() {
    const lifecycle = ++this.lifecycleGeneration
    this.disposed = false
    await this.activeListener?.remove()
    const listener = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void this.reconnect(true)
      else this.client.close()
    })
    if (lifecycle !== this.lifecycleGeneration || this.disposed) {
      await listener.remove()
      return
    }
    this.activeListener = listener
    if ($preferences.get().remoteURL) await this.connect().catch(() => undefined)
  }

  async configure(remoteURL: string, token?: string) {
    const previousURL = $preferences.get().remoteURL
    const configured = await this.connection.configure({ remoteURL, token })
    if (previousURL && previousURL !== configured.remoteURL) {
      this.scopeEpoch += 1
      clearGatewayQueries()
      this.clearForegroundScope()
      resetRoutes()
    }
    savePreferences({ remoteURL: configured.remoteURL })
    const { authMode, status } = await this.connection.probe()
    savePreferences({ authMode })
    $connection.set({ authMode, error: null, phase: 'disconnected', status })
    if (authMode === 'interactive') {
      try {
        await this.connection.request({ path: '/api/auth/me' })
      } catch {
        return
      }
    }
    return this.connect()
  }

  async connect() {
    const generation = ++this.reconnectGeneration
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    const { authMode, status } = await this.connection.probe()
    if (generation !== this.reconnectGeneration) throw new DOMException('Connection was superseded.', 'AbortError')
    savePreferences({ authMode })
    $connection.set({ authMode, error: null, phase: 'connecting', status })
    await this.openSocket(generation)
    await this.restoreOrCreateSession()
    if (generation !== this.reconnectGeneration) throw new DOMException('Connection was superseded.', 'AbortError')
    $connection.set({ authMode, error: null, phase: 'connected', status })
    await this.refreshSessions()
  }

  async login(provider: string) {
    await this.connection.login({ provider })
    return this.connect()
  }

  async passwordLogin(provider: string, username: string, password: string) {
    await this.connection.passwordLogin({ password, provider, username })
    return this.connect()
  }

  async logout() {
    ++this.reconnectGeneration
    ++this.scopeEpoch
    this.gateway.close()
    await this.connection.logout()
    clearGatewayQueries()
    this.clearForegroundScope()
    resetRoutes()
    $connection.set({ ...$connection.get(), phase: 'disconnected' })
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    ++this.reconnectGeneration
    ++this.scopeEpoch
    this.gateway.close()
    await queryClient.cancelQueries({ queryKey: ['gateway'] })
    this.clearForegroundScope()
    resetRoutes()
    savePreferences({ profile })
    await this.connect()
  }

  async newSession() {
    const epoch = this.scopeEpoch
    const connectionGeneration = this.reconnectGeneration
    const response = await this.client.request<SessionRPCResponse>('session.create', {
      profile: $preferences.get().profile,
      source: 'ios'
    })
    this.assertCurrent(epoch, connectionGeneration)
    await this.enforceContract(response)
    this.adoptSession(response)
  }

  async resumeSession(storedSessionId: string) {
    const epoch = this.scopeEpoch
    const connectionGeneration = this.reconnectGeneration
    const response = await this.client.request<SessionRPCResponse>('session.resume', {
      profile: $preferences.get().profile,
      session_id: storedSessionId,
      source: 'ios'
    })
    this.assertCurrent(epoch, connectionGeneration)
    await this.enforceContract(response)
    this.adoptSession(response)
    await this.reconcileHistory()
  }

  async refreshSessions() {
    const scope = this.scopeSnapshot()
    const response = await queryClient.fetchQuery({
      queryFn: () => this.gateway.rpc<{ sessions: StoredSession[] }>('session.list', {
        profile: scope.profile || null,
        limit: 200
      }),
      queryKey: gatewayScopeKey(scope, 'sessions', 'list'),
      staleTime: 0
    })
    if (this.scopeMatches(scope)) $sessions.set(response.sessions ?? [])
  }

  async renameSession(storedSessionId: string, title: string) {
    await this.mutateStoredSession(storedSessionId, 'PATCH', { title })
    const current = $chat.get()
    if (current.storedSessionId === storedSessionId && current.info) {
      $chat.set({ ...current, info: { ...current.info, title } as typeof current.info })
    }
    await this.refreshSessions()
  }

  async deleteSession(storedSessionId: string) {
    await this.mutateStoredSession(storedSessionId, 'DELETE')
    if ($chat.get().storedSessionId === storedSessionId) await this.newSession()
    await this.refreshSessions()
  }

  async archiveSession(storedSessionId: string) {
    await this.mutateStoredSession(storedSessionId, 'PATCH', { archived: true })
    await this.refreshSessions()
  }

  async branchSession() {
    const current = $chat.get()
    if (!current.runtimeSessionId || !current.storedSessionId) return
    const response = await this.client.request<SessionRPCResponse>('session.branch', {
      session_id: current.runtimeSessionId
    })
    this.adoptSession(response)
    await this.refreshSessions()
  }

  async send(text: string) {
    const content = text.trim()
    if (!content) return
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (current.running) {
      await this.client.request('prompt.submit', {
        queued: true,
        session_id: current.runtimeSessionId,
        text: content
      }, 1_800_000)
      return
    }
    $chat.set({
      ...current,
      error: null,
      messages: [...current.messages, { content, id: crypto.randomUUID(), role: 'user' }],
      running: true
    })
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    await this.client.request('prompt.submit', { session_id: current.runtimeSessionId, text: content }, 1_800_000)
  }

  async interrupt() {
    const sessionId = $chat.get().runtimeSessionId
    if (sessionId) await this.client.request('session.interrupt', { session_id: sessionId })
  }

  async steer(text: string) {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.client.request('session.steer', { session_id: sessionId, text: content })
  }

  async redirect(text: string) {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.client.request('session.redirect', { session_id: sessionId, text: content })
  }

  async retryFrom(userOrdinal: number, rowId: number, text: string) {
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    if (!Number.isInteger(userOrdinal) || userOrdinal < 0) throw new Error('A valid user-message position is required to edit history safely.')
    const content = text.trim()
    if (!content) return
    await this.client.request('prompt.submit', {
      ...(userOrdinal === 0 ? { confirm_empty_truncate: true } : {}),
      confirm_truncate: true,
      session_id: sessionId,
      text: content,
      truncate_before_row_id: rowId,
      truncate_before_user_ordinal: userOrdinal
    }, 1_800_000)
  }

  async attach(file: File) {
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (file.type.startsWith('image/')) {
      return this.client.request('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId })
    }
    return this.client.request('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId })
  }

  async respond(value: string, choice?: string) {
    const pending = $chat.get().pendingPrompt
    const sessionId = $chat.get().runtimeSessionId
    if (!pending || !sessionId) return
    const fields: Record<string, unknown> = { request_id: pending.requestId, session_id: sessionId }
    const method = `${pending.kind}.respond`
    if (pending.kind === 'clarify') fields.answer = value
    else if (pending.kind === 'approval') fields.choice = choice ?? value
    else if (pending.kind === 'sudo') fields.password = value
    else fields.value = value
    $chat.set({ ...$chat.get(), pendingPrompt: null })
    await this.client.request(method, fields)
  }

  async reconcileHistory() {
    const epoch = this.scopeEpoch
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    const response = await this.client.request<SessionHistoryResponse>('session.history', { session_id: sessionId })
    this.assertScopeEpoch(epoch)
    if ($chat.get().runtimeSessionId !== sessionId) return
    $chat.set({ ...$chat.get(), messages: toTranscript(response.messages), running: Boolean($chat.get().info?.running) })
  }

  async request<T>(method: string, params: Record<string, unknown> = {}) {
    return this.client.request<T>(method, params)
  }

  dispose() {
    this.disposed = true
    ++this.lifecycleGeneration
    this.client.close()
    void this.activeListener?.remove()
  }

  private async mutateStoredSession(
    storedSessionId: string,
    method: 'DELETE' | 'PATCH',
    body?: Record<string, unknown>
  ) {
    const profile = $preferences.get().profile
    const basePath = `/api/sessions/${encodeURIComponent(storedSessionId)}`
    const path = method === 'DELETE' && profile
      ? `${basePath}?profile=${encodeURIComponent(profile)}`
      : basePath

    await this.connection.request({
      ...(body === undefined ? {} : { body: profile ? { ...body, profile } : body }),
      method,
      path
    })
  }

  private async reconnect(reconcile: boolean) {
    const generation = ++this.reconnectGeneration
    this.client.close()
    for (const delay of RETRY_DELAYS) {
      if (generation !== this.reconnectGeneration || this.disposed) return
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      try {
        $connection.set({ ...$connection.get(), phase: 'connecting' })
        await this.openSocket(generation)
        await this.restoreOrCreateSession()
        if (reconcile) await this.reconcileHistory()
        $connection.set({ ...$connection.get(), error: null, phase: 'connected' })
        return
      } catch (error) {
        if (isReauthenticationError(error)) {
          $connection.set({ ...$connection.get(), error: 'Your Hermes session expired. Sign in again.', phase: 'error' })
          return
        }
        if (delay === RETRY_DELAYS.at(-1)) {
          $connection.set({ ...$connection.get(), error: errorMessage(error), phase: 'error' })
        }
      }
    }
  }

  private async openSocket(generation: number) {
    await this.gateway.connect($preferences.get().profile)
    if (generation !== this.reconnectGeneration) {
      this.gateway.close()
      throw new DOMException('Gateway scope changed.', 'AbortError')
    }
  }

  private async restoreOrCreateSession() {
    const stored = $chat.get().storedSessionId ?? this.readSessionBookmark()
    if (stored) {
      try {
        await this.resumeSession(stored)
        return
      } catch {
        this.clearSessionBookmark()
      }
    }
    await this.newSession()
  }

  private adoptSession(response: SessionRPCResponse) {
    const info = response.info ?? {}
    const storedSessionId = (response.stored_session_id ?? String(info.stored_session_id ?? '')) || null
    $chat.set({
      ...emptyChatState(),
      contractVersion: Number(info.desktop_contract ?? 0) || null,
      info: info as unknown as ChatState['info'],
      messages: toTranscript(response.messages),
      runtimeSessionId: response.session_id,
      storedSessionId
    })
    if (storedSessionId) localStorage.setItem(this.sessionBookmarkKey(), storedSessionId)
  }

  private async enforceContract(response: SessionRPCResponse) {
    const version = Number(response.info?.desktop_contract ?? 0)
    if (!Number.isFinite(version) || version < MINIMUM_CONTRACT) {
      this.client.close()
      const error = `This remote Hermes is too old for Hermes Mobile. Update the remote gateway (contract ${MINIMUM_CONTRACT} or newer).`
      $connection.set({ ...$connection.get(), error, phase: 'unsupported' })
      throw new Error(error)
    }
  }

  private onEvent(event: GatewayEvent) {
    const previous = $chat.get()
    const next = reduceGatewayEvent(previous, event)
    $chat.set(next)
    if (event.type === 'message.complete') void this.reconcileHistory()
  }

  private assertScopeEpoch(epoch: number) {
    if (epoch !== this.scopeEpoch) throw new DOMException('Gateway scope changed.', 'AbortError')
  }

  private assertCurrent(epoch: number, connectionGeneration: number) {
    this.assertScopeEpoch(epoch)
    if (connectionGeneration !== this.reconnectGeneration) throw new DOMException('Connection was superseded.', 'AbortError')
  }

  private clearForegroundScope() {
    $chat.set(emptyChatState())
    $sessions.set([])
  }

  private scopeSnapshot() {
    const preferences = $preferences.get()
    return { connectionKey: preferences.remoteURL, profile: preferences.profile }
  }

  private scopeMatches(scope: { connectionKey: string; profile?: null | string }) {
    const current = this.scopeSnapshot()
    return current.connectionKey === scope.connectionKey && current.profile === scope.profile
  }

  private sessionBookmarkKey() {
    const scope = this.scopeSnapshot()
    return `hermes.mobile.session:${encodeURIComponent(scope.connectionKey)}:${encodeURIComponent(scope.profile ?? 'default')}`
  }

  private readSessionBookmark() {
    return localStorage.getItem(this.sessionBookmarkKey())
  }

  private clearSessionBookmark() {
    localStorage.removeItem(this.sessionBookmarkKey())
  }
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Could not read attachment.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
}

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

export function isReauthenticationError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null
  if (candidate?.code === 'AUTH_REQUIRED') return true
  const message = String(candidate?.message ?? error).toLowerCase()
  return message.includes('http 401') || message.includes('unauthorized') || message.includes('no_cookie')
}
