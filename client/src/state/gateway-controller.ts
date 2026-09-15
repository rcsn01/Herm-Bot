import { observeAppLifecycle, type AppLifecycleHandle } from '~/native/app-lifecycle'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort } from '~/gateway/gateway-port'
import { cancelGatewayQueries, clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { createGatewayApi } from '~/gateway/gateway-api'
import { SessionRuntime, type RuntimeSession } from '~/gateway/session-runtime'
import { createSessionsApi, humanSessions, type SessionsApi } from '~/features/sessions/api'
import { HermesConnection, isNativeIOS, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetRoutes } from '~/navigation/navigation-store'
import { $chat, Conversation } from '~/state/conversation'
import { $connection, $preferences, $profileSwitching, $sessions, $sessionsHasMore, $sessionsLoadingMore, savePreferences } from '~/state/store'
import { startGroupEngine, stopGroupEngine } from '~/features/groups/group-engine'

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
  private activeListener?: AppLifecycleHandle
  private unsubscribeEvents?: () => void
  private unsubscribeState?: () => void

  constructor(
    private readonly connection: HermesConnectionPlugin = HermesConnection,
    gateway?: GatewayPort
  ) {
    const transport = gateway ?? new RemoteGateway(connection)
    this.runtime = new SessionRuntime(transport, {
      minimumContract: MINIMUM_CONTRACT,
      retryDelays: RETRY_DELAYS,
      sessionSource: isNativeIOS() ? 'ios' : 'mobile'
    })
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
    const listener = await observeAppLifecycle(({ isActive }) => {
      if (lifecycle !== this.lifecycleGeneration || this.disposed) return
      if (isActive) {
        this.appBackgrounded = false
        if (!this.logoutInProgress && $connection.get().phase !== 'disconnected') void this.reconnect(true)
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
    if ($preferences.get().remoteURL) {
      if (isNativeIOS()) await this.connect().catch(() => undefined)
      else await this.restoreBrowserConnection()
    } else {
      $connection.set({ ...$connection.get(), phase: 'disconnected' })
    }
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
    // The session is selected: paint the destination now. History and the
    // session list continue loading underneath (both use the captured scope,
    // so a profile change mid-open cannot publish another profile's data).
    $connection.set({ authMode, error: null, phase: 'connected', status })
    this.installGroupEngine()
    try {
      if (opened.resumed) await this.conversation.reconcileHistory(scope)
      await this.refreshSessions(scope)
    } catch (error) {
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
      throw error
    }
  }

  async login(provider: string) {
    const identity = await this.connection.login({ provider })
    // A browser OAuth login navigates away. The returning page reconnects.
    if (identity !== null) return this.connect()
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
    let logoutError: unknown
    try {
      await this.connection.logout()
    } catch (error) {
      logoutError = error
    } finally {
      this.invalidateReconnect()
      await this.teardownGatewayScope()
      $connection.set({ ...$connection.get(), phase: 'disconnected' })
      this.logoutInProgress = false
    }
    if (logoutError) {
      $connection.set({ ...$connection.get(), phase: 'disconnected', error: 'Disconnected locally. Gateway sign out could not be confirmed. Reconnect to finish signing out.' })
      throw logoutError
    }
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    this.invalidateReconnect()
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    $profileSwitching.set(true)
    try {
      await this.teardownGatewayScope({ cancelQueries: true })
      savePreferences({ profile })
      await this.connect()
    } finally {
      $profileSwitching.set(false)
    }
  }

  async newSession() {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.createSession(scope.profile)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.selectSession(session)
    // Every other session mutation (branch/rename/archive/delete) refreshes
    // the list; a create must too — the roster tap picks the newest session
    // from this store, so a stale list sends the next tap into an older
    // conversation. Best-effort: the create already succeeded, and a failed
    // listing must not fail the new chat.
    try {
      await this.refreshSessions(scope)
    } catch {
      /* store stays stale; the next connect/tap re-lists */
    }
  }

  async resumeSession(storedSessionId: string) {
    const selection = ++this.sessionSelectionGeneration
    const scope = currentGatewayScope()
    const session = await this.runtime.resumeSession(scope.profile, storedSessionId)
    if (selection !== this.sessionSelectionGeneration || !isCurrentGatewayScope(scope)) return
    this.selectSession(session)
    await this.conversation.reconcileHistory()
  }

  /**
   * Roster tap: enter a profile's latest conversation. Switches profiles when
   * needed, resumes the newest session from the refreshed list, and starts a
   * fresh session when none exist or the newest one is gone. A switch lets
   * connect() resume the profile's bookmarked session directly, so when that
   * is already the newest conversation no second resume happens.
   */
  async openProfile(profile: null | string) {
    const switched = profile !== $preferences.get().profile
    if (switched) await this.switchProfile(profile)
    const sessions = humanSessions($sessions.get())
    const latest = sessions.reduce<null | (typeof sessions)[number]>((newest, session) =>
      !newest || session.started_at > newest.started_at ? session : newest, null)
    const active = $chat.get()
    if (latest && active.runtimeSessionId && latest.id === active.storedSessionId) {
      // Already inside the target conversation; a switch reconciled it in
      // passing, a warm tap only needs a freshen.
      if (!switched) await this.conversation.reconcileHistory()
      return
    }
    if (latest) {
      try {
        await this.resumeSession(latest.id)
        return
      } catch {
        // The stored conversation may no longer exist; start a fresh one instead.
      }
    }
    await this.newSession()
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
    const activeId = $chat.get().storedSessionId
    if (activeId) {
      const source = sessions.find(session => session.id === activeId)?.source
      this.conversation.setSessionSource(activeId, typeof source === 'string' ? source : null)
    }
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
    stopGroupEngine()
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
    this.unsubscribeState?.()
    this.unsubscribeState = undefined
    this.runtime.dispose()
    void this.activeListener?.remove()
  }

  private async restoreBrowserConnection() {
    try {
      const { authMode, status } = await this.connection.probe()
      savePreferences({ authMode })
      $connection.set({ authMode, error: null, phase: 'connecting', status })
      if (authMode === 'interactive') {
        try {
          await this.connection.request({ path: '/api/auth/me' })
        } catch (error) {
          if (classifyGatewayError(error).kind === 'auth') {
            $connection.set({ authMode, error: null, phase: 'disconnected', status })
            return
          }
          throw error
        }
      }
      await this.connect()
    } catch (error) {
      this.applyConnectionError(error)
    }
  }

  /** Shared teardown for every Scope-ending transition (configure-URL change, logout, profile switch). */
  private async teardownGatewayScope(options: { cancelQueries?: boolean } = {}) {
    // A scope change stops the group engine: in-flight turns must not fire at
    // a dead gateway, and the mirror writer must not publish a dying scope's
    // pending state.
    stopGroupEngine()
    this.runtime.close()
    if (options.cancelQueries) await cancelGatewayQueries() // switchProfile: cancel in-flight, KEEP the cache
    else clearGatewayQueries()                              // configure/logout: remove the gateway cache
    this.clearForegroundScope()
    resetRoutes()
  }

  private sessionsApi(scope: CurrentGatewayScope): SessionsApi {
    return createSessionsApi(createGatewayApi(this.runtime, scope.profile))
  }

  /** Point the group send engine at this scope's transport and arm the
   *  mirror writer (the initial pull happens BEFORE any local publish — the
   *  receive half of the sync contract). */
  private installGroupEngine() {
    startGroupEngine((method, params) => this.runtime.rpc(method, params))
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
    const source = session.storedSessionId
      ? $sessions.get().find(candidate => candidate.id === session.storedSessionId)?.source
      : null
    this.conversation.adopt(session, typeof source === 'string' ? source : null)
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