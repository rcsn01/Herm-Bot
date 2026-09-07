import { App } from '@capacitor/app'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { cancelGatewayQueries, clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { createGatewayApi } from '~/gateway/gateway-api'
import { SessionRuntime, type RuntimeSession } from '~/gateway/session-runtime'
import { createSessionsApi, type SessionsApi } from '~/features/sessions/api'
import { HermesConnection, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetRoutes } from '~/navigation/navigation-store'
import { $chat, Conversation } from '~/state/conversation'
import { $connection, $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore, savePreferences } from '~/state/store'

export const MINIMUM_CONTRACT = 6
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]
const SESSION_LIST_PAGE_SIZE = 30

export class GatewayController {
  readonly conversation: Conversation
  readonly gateway: GatewayPort
  private readonly runtime: SessionRuntime
  private lifecycleGeneration = 0
  private reconnectGeneration = 0
  private appBackgrounded = false
  private logoutInProgress = false
  private sessionSelectionGeneration = 0
  private sessionListLimit = SESSION_LIST_PAGE_SIZE
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
    this.conversation = new Conversation(this.runtime)
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
      $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
      await this.teardownGatewayScope()
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
    this.selectSession(opened.session)
    try {
      if (opened.resumed) await this.conversation.reconcileHistory(scope)
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
    $connection.set({ ...$connection.get(), error: null, phase: 'disconnected' })
    this.runtime.close()
    try {
      await this.connection.logout()
    } finally {
      this.invalidateReconnect()
      await this.teardownGatewayScope()
      $connection.set({ ...$connection.get(), phase: 'disconnected' })
      this.logoutInProgress = false
    }
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    this.invalidateReconnect()
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    await this.teardownGatewayScope({ cancelQueries: true })
    savePreferences({ profile })
    await this.connect()
  }

  async newSession() {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.createSession(scope.profile)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.selectSession(session)
  }

  async resumeSession(storedSessionId: string) {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.resumeSession(scope.profile, storedSessionId)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.selectSession(session)
    await this.conversation.reconcileHistory()
  }

  async refreshSessions(scope: CurrentGatewayScope = currentGatewayScope()) {
    const limit = this.sessionListLimit
    const response = await queryClient.fetchQuery({
      queryFn: ({ signal }) => this.sessionsApi(scope).list(limit, signal),
      queryKey: gatewayScopeKey(scope, 'sessions', 'list', limit),
      staleTime: 0
    })
    if (!isCurrentGatewayScope(scope)) return
    const sessions = response.sessions ?? []
    $sessions.set(sessions)
    $sessionsHasMore.set(sessions.length >= limit)
  }

  async loadMoreSessions() {
    if ($sessionsLoadingMore.get() || !$sessionsHasMore.get()) return
    const scope = currentGatewayScope()
    const previousLimit = this.sessionListLimit
    this.sessionListLimit += SESSION_LIST_PAGE_SIZE
    $sessionsLoadingMore.set(true)
    try {
      await this.refreshSessions(scope)
    } catch (error) {
      if (isCurrentGatewayScope(scope)) this.sessionListLimit = previousLimit
      throw error
    } finally {
      if (isCurrentGatewayScope(scope)) $sessionsLoadingMore.set(false)
    }
  }

  async renameSession(storedSessionId: string, title: string) {
    const scope = currentGatewayScope()
    await this.sessionsApi(scope).rename(storedSessionId, title)
    if (!isCurrentGatewayScope(scope)) return
    this.conversation.retitleActive(storedSessionId, title)
    await this.refreshSessions()
  }

  async deleteSession(storedSessionId: string) {
    const scope = currentGatewayScope()
    await this.sessionsApi(scope).remove(storedSessionId)
    if (!isCurrentGatewayScope(scope)) return
    if ($chat.get().storedSessionId === storedSessionId) await this.newSession()
    if (isCurrentGatewayScope(scope)) await this.refreshSessions()
  }

  async archiveSession(storedSessionId: string) {
    const scope = currentGatewayScope()
    await this.sessionsApi(scope).archive(storedSessionId)
    if (isCurrentGatewayScope(scope)) await this.refreshSessions()
  }

  async branchSession() {
    const current = $chat.get()
    if (!current.runtimeSessionId || !current.storedSessionId) return
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.branchSession(current.runtimeSessionId)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.selectSession(session)
    await this.refreshSessions()
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

  /** Shared teardown for every Scope-ending transition (configure-URL change, logout, profile switch). */
  private async teardownGatewayScope(options: { cancelQueries?: boolean } = {}) {
    this.runtime.close()
    if (options.cancelQueries) await cancelGatewayQueries() // switchProfile: cancel in-flight, KEEP the cache
    else clearGatewayQueries()                              // configure/logout: remove the gateway cache
    this.clearForegroundScope()
    resetRoutes()
  }

  private sessionsApi(scope: CurrentGatewayScope): SessionsApi {
    return createSessionsApi(createGatewayApi(this.runtime, scope.profile))
  }

  private subscribeRuntime() {
    this.unsubscribeEvents = this.runtime.subscribe(event => this.conversation.onGatewayEvent(event))
    this.unsubscribeState = this.runtime.subscribeState(state => {
      if (state === 'closed' && !this.disposed && !this.appBackgrounded && !this.logoutInProgress && $connection.get().phase === 'connected') {
        $connection.set({ ...$connection.get(), error: null, phase: 'reconnecting' })
        void this.reconnect(true)
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
      this.selectSession(opened.session)
      if (reconcile) await this.conversation.reconcileHistory(scope)
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      $connection.set({ ...$connection.get(), error: null, phase: 'connected' })
    } catch (error) {
      const classified = classifyGatewayError(error)
      if (classified.kind === 'aborted' || !this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
    }
  }

  /** Install the session as the open conversation and remember it for reconnects. */
  private selectSession(session: RuntimeSession) {
    this.conversation.adopt(session)
    if (session.storedSessionId) localStorage.setItem(this.sessionBookmarkKey(), session.storedSessionId)
  }

  private applyConnectionError(error: unknown) {
    const classified = classifyGatewayError(error)
    if (classified.kind === 'unsupported') {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'unsupported' })
    } else if (classified.kind === 'auth') {
      $connection.set({ ...$connection.get(), error: 'Your Hermes session expired. Sign in again.', phase: 'error' })
    } else {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'error' })
    }
  }

  private clearForegroundScope() {
    this.sessionListLimit = SESSION_LIST_PAGE_SIZE
    this.conversation.reset()
    $sessions.set([])
    $sessionsHasMore.set(false)
    $sessionsLoadingMore.set(false)
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