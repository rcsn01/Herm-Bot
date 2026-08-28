import { App } from '@capacitor/app'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '@hermes/shared'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { SessionRuntime, toTranscript, type RuntimeSession } from '~/gateway/session-runtime'
import type { StoredSession } from '~/lib/types'
import { HermesConnection, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetRoutes } from '~/navigation/navigation-store'
import { emptyChatState, reduceGatewayEvent } from '~/state/event-reducer'
import { $chat, $connection, $preferences, $sessions, savePreferences } from '~/state/store'

export const MINIMUM_CONTRACT = 3
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]
export { toTranscript }

export class GatewayController {
  readonly gateway: GatewayPort
  private readonly runtime: SessionRuntime
  private lifecycleGeneration = 0
  private sessionSelectionGeneration = 0
  private disposed = false
  private activeListener?: Awaited<ReturnType<typeof App.addListener>>
  private unsubscribeEvents?: () => void
  private unsubscribeState?: () => void

  constructor(
    private readonly connection: HermesConnectionPlugin = HermesConnection,
    gateway?: GatewayPort
  ) {
    const transport = gateway ?? new RemoteGateway(connection)
    this.runtime = new SessionRuntime(transport, { minimumContract: MINIMUM_CONTRACT, retryDelays: RETRY_DELAYS })
    this.gateway = this.runtime
    this.subscribeRuntime()
  }

  async initialize() {
    const lifecycle = ++this.lifecycleGeneration
    const wasDisposed = this.disposed
    this.disposed = false
    if (wasDisposed) this.subscribeRuntime()
    await this.activeListener?.remove()
    const listener = await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void this.reconnect(true)
      else this.runtime.close()
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
      this.runtime.close()
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
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    const storedSessionId = $chat.get().storedSessionId ?? this.readSessionBookmark()
    let opened
    try {
      opened = await this.runtime.open(
        { profile: $preferences.get().profile, storedSessionId },
        () => this.connection.probe()
      )
    } catch (error) {
      this.applyConnectionError(error)
      throw error
    }
    const { authMode, status } = opened.preparation
    savePreferences({ authMode })
    $connection.set({ authMode, error: null, phase: 'connecting', status })
    if (storedSessionId && !opened.resumed) this.clearSessionBookmark()
    this.adoptSession(opened.session)
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
    this.runtime.close()
    await this.connection.logout()
    clearGatewayQueries()
    this.clearForegroundScope()
    resetRoutes()
    $connection.set({ ...$connection.get(), phase: 'disconnected' })
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    this.runtime.close()
    await queryClient.cancelQueries({ queryKey: ['gateway'] })
    this.clearForegroundScope()
    resetRoutes()
    savePreferences({ profile })
    await this.connect()
  }

  async newSession() {
    const selection = ++this.sessionSelectionGeneration
    const session = await this.runtime.createSession($preferences.get().profile)
    if (selection !== this.sessionSelectionGeneration) return
    this.adoptSession(session)
  }

  async resumeSession(storedSessionId: string) {
    const selection = ++this.sessionSelectionGeneration
    const session = await this.runtime.resumeSession($preferences.get().profile, storedSessionId)
    if (selection !== this.sessionSelectionGeneration) return
    this.adoptSession(session)
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
    const selection = ++this.sessionSelectionGeneration
    const session = await this.runtime.branchSession(current.runtimeSessionId)
    if (selection !== this.sessionSelectionGeneration) return
    this.adoptSession(session)
    await this.refreshSessions()
  }

  async send(text: string) {
    const content = text.trim()
    if (!content) return
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (current.running) {
      await this.runtime.rpc('prompt.submit', {
        queued: true,
        session_id: current.runtimeSessionId,
        text: content
      }, { timeoutMs: 1_800_000 })
      return
    }
    $chat.set({
      ...current,
      error: null,
      messages: [...current.messages, { content, id: crypto.randomUUID(), role: 'user' }],
      running: true
    })
    await Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined)
    try {
      await this.runtime.rpc('prompt.submit', { session_id: current.runtimeSessionId, text: content }, { timeoutMs: 1_800_000 })
    } catch (error) {
      const latest = $chat.get()
      if (latest.runtimeSessionId === current.runtimeSessionId) {
        $chat.set({ ...latest, error: errorMessage(error), running: false })
      }
      throw error
    }
  }

  async interrupt() {
    const sessionId = $chat.get().runtimeSessionId
    if (sessionId) await this.runtime.rpc('session.interrupt', { session_id: sessionId })
  }

  async steer(text: string) {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.steer', { session_id: sessionId, text: content })
  }

  async redirect(text: string) {
    const sessionId = $chat.get().runtimeSessionId
    const content = text.trim()
    if (sessionId && content) await this.runtime.rpc('session.redirect', { session_id: sessionId, text: content })
  }

  async retryFrom(userOrdinal: number, rowId: number, text: string) {
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    if (!Number.isInteger(userOrdinal) || userOrdinal < 0) throw new Error('A valid user-message position is required to edit history safely.')
    const content = text.trim()
    if (!content) return
    await this.runtime.rpc('prompt.submit', {
      ...(userOrdinal === 0 ? { confirm_empty_truncate: true } : {}),
      confirm_truncate: true,
      session_id: sessionId,
      text: content,
      truncate_before_row_id: rowId,
      truncate_before_user_ordinal: userOrdinal
    }, { timeoutMs: 1_800_000 })
  }

  async attach(file: File) {
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (file.type.startsWith('image/')) {
      return this.runtime.rpc('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId })
    }
    return this.runtime.rpc('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId })
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
    await this.runtime.rpc(method, fields)
    const current = $chat.get()
    if (current.pendingPrompt?.requestId === pending.requestId) {
      $chat.set({ ...current, pendingPrompt: null })
    }
  }

  async reconcileHistory() {
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    const messages = await this.runtime.history(sessionId)
    if ($chat.get().runtimeSessionId !== sessionId) return
    $chat.set({ ...$chat.get(), messages, running: Boolean($chat.get().info?.running) })
  }

  async request<T>(method: string, params: Record<string, unknown> = {}) {
    return this.runtime.rpc<T>(method, params)
  }

  dispose() {
    this.disposed = true
    ++this.lifecycleGeneration
    ++this.sessionSelectionGeneration
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
    this.unsubscribeState?.()
    this.unsubscribeState = undefined
    this.runtime.dispose()
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

    await this.runtime.request({
      ...(body === undefined ? {} : { body: profile ? { ...body, profile } : body }),
      method,
      path
    })
  }

  private subscribeRuntime() {
    this.unsubscribeEvents = this.runtime.subscribe(event => this.onEvent(event))
    this.unsubscribeState = this.runtime.subscribeState(state => {
      if (state === 'closed' && !this.disposed && $connection.get().phase === 'connected') {
        $connection.set({ ...$connection.get(), phase: 'disconnected' })
      }
    })
  }

  private async reconnect(reconcile: boolean) {
    if (this.disposed) return
    $connection.set({ ...$connection.get(), phase: 'connecting' })
    const storedSessionId = $chat.get().storedSessionId ?? this.readSessionBookmark()
    try {
      const opened = await this.runtime.reopen({ profile: $preferences.get().profile, storedSessionId })
      if (storedSessionId && !opened.resumed) this.clearSessionBookmark()
      this.adoptSession(opened.session)
      if (reconcile) await this.reconcileHistory()
      $connection.set({ ...$connection.get(), error: null, phase: 'connected' })
    } catch (error) {
      if (classifyGatewayError(error).kind === 'aborted') return
      this.applyConnectionError(error)
    }
  }

  private adoptSession(session: RuntimeSession) {
    $chat.set({
      ...emptyChatState(),
      contractVersion: session.contractVersion,
      info: session.info,
      messages: session.messages,
      runtimeSessionId: session.runtimeSessionId,
      storedSessionId: session.storedSessionId
    })
    if (session.storedSessionId) localStorage.setItem(this.sessionBookmarkKey(), session.storedSessionId)
  }

  private applyConnectionError(error: unknown) {
    const classified = classifyGatewayError(error)
    if (classified.kind === 'unsupported') {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'unsupported' })
    } else if (isReauthenticationError(classified)) {
      $connection.set({ ...$connection.get(), error: 'Your Hermes session expired. Sign in again.', phase: 'error' })
    } else {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'error' })
    }
  }

  private onEvent(event: GatewayEvent) {
    const previous = $chat.get()
    const next = reduceGatewayEvent(previous, event)
    $chat.set(next)
    if (event.type === 'message.complete') void this.reconcileHistory()
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
  const candidate = error as { code?: unknown; kind?: unknown; message?: unknown; status?: unknown } | null
  if (candidate?.kind === 'auth' || candidate?.code === 'AUTH_REQUIRED' || candidate?.status === 401 || candidate?.status === 403) return true
  const message = String(candidate?.message ?? error).toLowerCase()
  return message.includes('http 401') || message.includes('unauthorized') || message.includes('no_cookie')
}
