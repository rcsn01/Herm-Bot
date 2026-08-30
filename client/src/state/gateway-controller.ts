import { App } from '@capacitor/app'
import { Haptics, ImpactStyle } from '@capacitor/haptics'
import type { GatewayEvent } from '@hermes/shared'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { profileKey, profilePath } from '~/gateway/profile-path'
import { SessionRuntime, toTranscript, type RuntimeSession } from '~/gateway/session-runtime'
import type { StoredSession } from '~/lib/types'
import { HermesConnection, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetRoutes } from '~/navigation/navigation-store'
import { emptyChatState, reduceGatewayEvent } from '~/state/event-reducer'
import { $chat, $connection, $preferences, $sessions, savePreferences } from '~/state/store'

export const MINIMUM_CONTRACT = 6
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]
export { toTranscript }

export class GatewayController {
  readonly gateway: GatewayPort
  private readonly runtime: SessionRuntime
  private lifecycleGeneration = 0
  private reconnectGeneration = 0
  private appBackgrounded = false
  private logoutInProgress = false
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
    this.appBackgrounded = false
    if (wasDisposed) this.subscribeRuntime()
    await this.activeListener?.remove()
    const listener = await App.addListener('appStateChange', ({ isActive }) => {
      if (lifecycle !== this.lifecycleGeneration || this.disposed) return
      if (isActive) {
        this.appBackgrounded = false
        if (!this.logoutInProgress) void this.reconnect(true)
      } else {
        this.appBackgrounded = true
        this.invalidateReconnect()
        if ($connection.get().phase === 'connected') {
          $connection.set({ ...$connection.get(), error: null, phase: 'reconnecting' })
        }
        this.runtime.close()
      }
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
      this.invalidateReconnect()
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
    const generation = ++this.reconnectGeneration
    const scope = currentGatewayScope()
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    const storedSessionId = $chat.get().storedSessionId ?? this.readSessionBookmark(scope)
    let opened
    try {
      opened = await this.runtime.open(
        { profile: scope.profile, storedSessionId },
        () => this.connection.probe()
      )
    } catch (error) {
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
      throw error
    }
    if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
    const { authMode, status } = opened.preparation
    savePreferences({ authMode })
    $connection.set({ authMode, error: null, phase: 'connecting', status })
    if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
    if (storedSessionId && !opened.resumed) this.clearSessionBookmark(scope)
    this.adoptSession(opened.session)
    try {
      // Keep the connection in `connecting` until the captured profile's
      // session list has been refreshed. A profile can change while the
      // transport is opening; using current preferences here would fetch and
      // publish a different profile's list before the stale connect notices.
      await this.refreshSessions(scope)
    } catch (error) {
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
      throw error
    }
    if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
    $connection.set({ authMode, error: null, phase: 'connected', status })
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
    this.logoutInProgress = true
    this.invalidateReconnect()
    this.runtime.close()
    try {
      await this.connection.logout()
    } finally {
      this.invalidateReconnect()
      this.runtime.close()
      clearGatewayQueries()
      this.clearForegroundScope()
      resetRoutes()
      $connection.set({ ...$connection.get(), phase: 'disconnected' })
      this.logoutInProgress = false
    }
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    this.invalidateReconnect()
    this.runtime.close()
    await queryClient.cancelQueries({ queryKey: ['gateway'] })
    this.clearForegroundScope()
    resetRoutes()
    savePreferences({ profile })
    await this.connect()
  }

  async newSession() {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.createSession(scope.profile)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.adoptSession(session)
  }

  async resumeSession(storedSessionId: string) {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.resumeSession(scope.profile, storedSessionId)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.adoptSession(session)
    await this.reconcileHistory()
  }

  async refreshSessions(scope: CurrentGatewayScope = currentGatewayScope()) {
    const response = await queryClient.fetchQuery({
      queryFn: ({ signal }) => this.gateway.rpc<{ sessions: StoredSession[] }>('session.list', {
        profile: profileKey(scope.profile),
        limit: 200
      }, { signal }),
      queryKey: gatewayScopeKey(scope, 'sessions', 'list'),
      staleTime: 0
    })
    if (isCurrentGatewayScope(scope)) $sessions.set(response.sessions ?? [])
  }

  async renameSession(storedSessionId: string, title: string) {
    const scope = await this.mutateStoredSession(storedSessionId, 'PATCH', { title })
    if (!isCurrentGatewayScope(scope)) return
    const current = $chat.get()
    if (current.storedSessionId === storedSessionId && current.info) {
      $chat.set({ ...current, info: { ...current.info, title } as typeof current.info })
    }
    await this.refreshSessions()
  }

  async deleteSession(storedSessionId: string) {
    const scope = await this.mutateStoredSession(storedSessionId, 'DELETE')
    if (!isCurrentGatewayScope(scope)) return
    if ($chat.get().storedSessionId === storedSessionId) await this.newSession()
    if (isCurrentGatewayScope(scope)) await this.refreshSessions()
  }

  async archiveSession(storedSessionId: string) {
    const scope = await this.mutateStoredSession(storedSessionId, 'PATCH', { archived: true })
    if (isCurrentGatewayScope(scope)) await this.refreshSessions()
  }

  async branchSession() {
    const current = $chat.get()
    if (!current.runtimeSessionId || !current.storedSessionId) return
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.branchSession(current.runtimeSessionId)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.adoptSession(session)
    await this.refreshSessions()
  }

  async send(text: string) {
    const content = text.trim()
    if (!content) return
    const scope = currentGatewayScope()
    const current = $chat.get()
    if (!current.runtimeSessionId) throw new Error('No active session.')
    if (current.running) {
      try {
        await this.runtime.rpc('prompt.submit', {
          queued: true,
          session_id: current.runtimeSessionId,
          text: content
        }, { timeoutMs: 1_800_000 })
      } catch (error) {
        if (isCurrentGatewayScope(scope)) throw error
      }
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
      if (!isCurrentGatewayScope(scope)) return
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
    const scope = currentGatewayScope()
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    if (!Number.isInteger(rowId) || rowId <= 0) throw new Error('A durable message row is required to edit history safely.')
    if (!Number.isInteger(userOrdinal) || userOrdinal < 0) throw new Error('A valid user-message position is required to edit history safely.')
    const content = text.trim()
    if (!content) return
    try {
      await this.runtime.rpc('prompt.submit', {
        ...(userOrdinal === 0 ? { confirm_empty_truncate: true } : {}),
        confirm_truncate: true,
        session_id: sessionId,
        text: content,
        truncate_before_row_id: rowId,
        truncate_before_user_ordinal: userOrdinal
      }, { timeoutMs: 1_800_000 })
    } catch (error) {
      if (isCurrentGatewayScope(scope)) throw error
    }
  }

  async attach(file: File) {
    const scope = currentGatewayScope()
    const limit = file.type.startsWith('image/') ? 20 * 1_024 * 1_024 : 50 * 1_024 * 1_024
    if (file.size > limit) throw new Error(`This attachment exceeds the ${limit / 1_024 / 1_024} MB mobile upload limit.`)
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) throw new Error('No active session.')
    const dataUrl = await fileToDataURL(file)
    if (!isCurrentGatewayScope(scope)) return undefined
    if (file.type.startsWith('image/')) {
      return this.runtime.rpc('image.attach_bytes', { data_url: dataUrl, name: file.name, session_id: sessionId })
    }
    return this.runtime.rpc('file.attach', { data_url: dataUrl, name: file.name, path: file.name, session_id: sessionId })
  }

  async respond(value: string, choice?: string) {
    const scope = currentGatewayScope()
    const pending = $chat.get().pendingPrompt
    const sessionId = $chat.get().runtimeSessionId
    if (!pending || !sessionId) return
    const fields: Record<string, unknown> = { request_id: pending.requestId, session_id: sessionId }
    const method = `${pending.kind}.respond`
    if (pending.kind === 'clarify') fields.answer = value
    else if (pending.kind === 'approval') fields.choice = choice ?? value
    else if (pending.kind === 'sudo') fields.password = value
    else fields.value = value
    try {
      await this.runtime.rpc(method, fields)
    } catch (error) {
      if (isCurrentGatewayScope(scope)) throw error
      return
    }
    if (!isCurrentGatewayScope(scope)) return
    const current = $chat.get()
    if (current.pendingPrompt?.requestId === pending.requestId) {
      $chat.set({ ...current, pendingPrompt: null })
    }
  }

  async reconcileHistory(scope: CurrentGatewayScope = currentGatewayScope()) {
    const sessionId = $chat.get().runtimeSessionId
    if (!sessionId) return
    const messages = await this.runtime.history(sessionId)
    if (!isCurrentGatewayScope(scope) || $chat.get().runtimeSessionId !== sessionId) return
    $chat.set({ ...$chat.get(), messages, running: Boolean($chat.get().info?.running) })
  }

  async request<T>(method: string, params: Record<string, unknown> = {}) {
    const scope = currentGatewayScope()
    const result = await this.runtime.rpc<T>(method, params)
    if (!isCurrentGatewayScope(scope)) throw new DOMException('Gateway scope changed.', 'AbortError')
    return result
  }

  dispose() {
    this.disposed = true
    ++this.lifecycleGeneration
    this.invalidateReconnect()
    this.appBackgrounded = false
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
    const scope = currentGatewayScope()
    const profile = profileKey(scope.profile)
    const path = profilePath(`/api/sessions/${encodeURIComponent(storedSessionId)}`, scope.profile)

    await this.runtime.request({
      ...(body === undefined ? {} : { body: { ...body, profile } }),
      method,
      path
    })
    if (!isCurrentGatewayScope(scope)) throw new DOMException('Gateway scope changed.', 'AbortError')
    return scope
  }

  private subscribeRuntime() {
    this.unsubscribeEvents = this.runtime.subscribe(event => this.onEvent(event))
    this.unsubscribeState = this.runtime.subscribeState(state => {
      if (state === 'closed' && !this.disposed && !this.appBackgrounded && $connection.get().phase === 'connected') {
        $connection.set({ ...$connection.get(), phase: 'disconnected' })
      }
    })
  }

  private async reconnect(reconcile: boolean) {
    if (this.disposed) return
    const generation = ++this.reconnectGeneration
    const scope = currentGatewayScope()
    const previousPhase = $connection.get().phase
    const hasCachedSession = previousPhase === 'reconnecting' && Boolean($chat.get().runtimeSessionId)
    $connection.set({
      ...$connection.get(),
      error: null,
      phase: hasCachedSession ? 'reconnecting' : 'connecting'
    })
    const storedSessionId = $chat.get().storedSessionId ?? this.readSessionBookmark(scope)
    try {
      const opened = await this.runtime.reopen({ profile: scope.profile, storedSessionId })
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      if (storedSessionId && !opened.resumed) this.clearSessionBookmark(scope)
      this.adoptSession(opened.session)
      if (reconcile) await this.reconcileHistory(scope)
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      $connection.set({ ...$connection.get(), error: null, phase: 'connected' })
    } catch (error) {
      const classified = classifyGatewayError(error)
      if (classified.kind === 'aborted' || !this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
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

  private invalidateReconnect() {
    ++this.reconnectGeneration
  }

  private isCurrentReconnect(generation: number) {
    return !this.disposed && generation === this.reconnectGeneration
  }

  private scopeSnapshot() {
    const preferences = $preferences.get()
    return { connectionKey: preferences.remoteURL, profile: preferences.profile }
  }

  private sessionBookmarkKey(scope: { connectionKey: string; profile: null | string } = this.scopeSnapshot()) {
    return `hermes.mobile.session:${encodeURIComponent(scope.connectionKey)}:${encodeURIComponent(scope.profile ?? 'default')}`
  }

  private readSessionBookmark(scope: { connectionKey: string; profile: null | string } = this.scopeSnapshot()) {
    return localStorage.getItem(this.sessionBookmarkKey(scope))
  }

  private clearSessionBookmark(scope: { connectionKey: string; profile: null | string } = this.scopeSnapshot()) {
    localStorage.removeItem(this.sessionBookmarkKey(scope))
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
