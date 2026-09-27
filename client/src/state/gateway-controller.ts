import { observeAppLifecycle, type AppLifecycleHandle } from '~/native/app-lifecycle'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort, GatewayTransport } from '~/gateway/gateway-port'
import { cancelGatewayQueries, clearGatewayQueries, queryClient } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { gatewayScopeKey } from '~/gateway/gateway-scope'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { createGatewayApi } from '~/gateway/gateway-api'
import { SessionRuntime } from '~/gateway/session-runtime'
import { createSessionsApi, type SessionsApi } from '~/features/sessions/api'
import { HermesConnection, isNativeIOS, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetWorkspace } from '~/navigation/workspace-navigation'
import { Conversation } from '~/state/conversation'
import { $connection, $preferences, $profileSwitching, $sessions, $sessionsHasMore, $sessionsLoadingMore, savePreferences } from '~/state/store'
import { createSessionSelection, type SessionSelection } from '~/state/session-selection'
import { startGroupEngine, stopGroupEngine } from '~/features/groups/group-engine'

export const MINIMUM_CONTRACT = 6
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]
const SESSION_LIST_PAGE_SIZE = 30

export class GatewayController {
  readonly conversation: Conversation
  readonly gateway: GatewayPort
  private readonly runtime: SessionRuntime
  private readonly transport: GatewayTransport
  private readonly selection: SessionSelection
  private lifecycleGeneration = 0
  private reconnectGeneration = 0
  private appBackgrounded = false
  private logoutInProgress = false
  private sessionListLimit = SESSION_LIST_PAGE_SIZE
  private disposed = false
  private activeListener?: AppLifecycleHandle
  private unsubscribeEvents?: () => void
  private unsubscribeState?: () => void

  constructor(
    private readonly connection: HermesConnectionPlugin = HermesConnection,
    gateway?: GatewayTransport
  ) {
    this.transport = gateway ?? new RemoteGateway(connection)
    this.runtime = new SessionRuntime(this.transport, {
      minimumContract: MINIMUM_CONTRACT,
      retryDelays: RETRY_DELAYS,
      sessionSource: isNativeIOS() ? 'ios' : 'mobile'
    })
    this.gateway = this.runtime
    this.conversation = new Conversation(this.runtime)
    this.selection = createSessionSelection({
      runtime: this.runtime,
      conversation: this.conversation,
      refreshSessions: scope => this.refreshSessions(scope)
    })
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
    let restored
    try {
      restored = await this.selection.restore(
        stored => this.runtime.open({ profile: scope.profile, storedSessionId: stored }, () => this.connection.probe()),
        () => this.isCurrentReconnect(generation)
      )
    } catch (error) {
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
      throw error
    }
    if (!restored) return
    const { opened } = restored
    const { authMode, status } = opened.preparation
    savePreferences({ authMode })
    // The session is already selected — restore() adopted it and wrote the
    // bookmark before resolving. Paint the destination now; history and the
    // session list continue loading underneath (both use the captured scope,
    // so a profile change mid-open cannot publish another profile's data).
    $connection.set({ authMode, error: null, phase: 'connected', status })
    this.installGroupEngine(scope)
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
    const outcome = await this.selection.select({ kind: 'create' })
    if (!outcome) return
  }

  async resumeSession(storedSessionId: string) {
    return this.selection.select({ kind: 'resume', storedSessionId })
  }

  async openProfile(profile: null | string) {
    const switched = profile !== $preferences.get().profile
    if (switched) await this.switchProfile(profile)
    return this.selection.select({ kind: 'latest', freshen: !switched })
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
    const activeId = this.selection.activeStoredSessionId()
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
    await this.refreshSessions(scope)
  }

  async deleteSession(storedSessionId: string) {
    const scope = currentGatewayScope()
    await this.sessionsApi(scope).remove(storedSessionId)
    if (!isCurrentGatewayScope(scope)) return
    if (this.selection.activeStoredSessionId() === storedSessionId) await this.newSession()
    if (isCurrentGatewayScope(scope)) await this.refreshSessions(scope)
  }

  async archiveSession(storedSessionId: string) {
    const scope = currentGatewayScope()
    await this.sessionsApi(scope).archive(storedSessionId)
    if (isCurrentGatewayScope(scope)) await this.refreshSessions(scope)
  }

  async branchSession() {
    await this.selection.select({ kind: 'branch' })
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
    this.selection.invalidate()
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
    resetWorkspace()
  }

  private sessionsApi(scope: CurrentGatewayScope): SessionsApi {
    return createSessionsApi(createGatewayApi(this.runtime, scope.profile))
  }

  /** Point the group send engine at this scope's transport and connection
   *  key and arm the mirror writer (the initial pull happens BEFORE any local
   *  publish — the receive half of the sync contract). The engine scopes its
   *  stored session ids to the captured `connectionKey`, not the Profile: a
   *  profile switch restarts the engine with the same key and keeps them. */
  private installGroupEngine(scope: CurrentGatewayScope) {
    startGroupEngine(
      (method, params, options) => this.runtime.rpc(method, params, options),
      scope.connectionKey
    )
  }

  private subscribeRuntime() {
    this.unsubscribeEvents = this.transport.subscribe(event => this.conversation.onGatewayEvent(event))
    this.unsubscribeState = this.transport.subscribeState(state => {
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
    const hasCachedSession = previousPhase === 'reconnecting' && this.selection.hasLiveSession()
    $connection.set({
      ...$connection.get(),
      error: null,
      phase: hasCachedSession ? 'reconnecting' : 'connecting'
    })
    try {
      const restored = await this.selection.restore(
        stored => this.runtime.reopen({ profile: scope.profile, storedSessionId: stored }),
        () => this.isCurrentReconnect(generation)
      )
      if (!restored) return
      if (reconcile) await this.conversation.reconcileHistory(scope)
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      $connection.set({ ...$connection.get(), error: null, phase: 'connected' })
    } catch (error) {
      const classified = classifyGatewayError(error)
      if (classified.kind === 'aborted' || !this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
    }
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
}