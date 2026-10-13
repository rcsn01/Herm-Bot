import { $chat } from './conversation'
import { $networkStatus, observeNetworkStatus } from './network-status'
import { transcriptCache, type CachedConversation } from './transcript-cache'
import { createGuardedGateway } from '~/gateway/guarded-gateway'
import { GatewayError } from '~/gateway/gateway-error'
import { chatDrafts } from '~/features/chat/chat-drafts'
import { $draftOwner, draftPrincipal, lockDraftOwner, verifyDraftOwner } from '~/state/draft-owner'
import { observeAppLifecycle, type AppLifecycleHandle } from '~/native/app-lifecycle'

import { classifyGatewayError } from '~/gateway/gateway-error'
import type { GatewayPort, GatewayTransport } from '~/gateway/gateway-port'
import { cancelGatewayQueries, clearGatewayQueries } from '~/gateway/query-client'
import { RemoteGateway } from '~/gateway/remote-gateway'
import { currentGatewayScope, isCurrentGatewayScope, type CurrentGatewayScope } from '~/gateway/scope-guard'
import { createGatewayApi } from '~/gateway/gateway-api'
import { SessionRuntime } from '~/gateway/session-runtime'
import { createSessionsApi, type SessionsApi } from '~/features/sessions/api'
import { HermesConnection, isNativeIOS, type HermesConnectionPlugin } from '~/native/hermes-connection'
import { resetWorkspace } from '~/navigation/workspace-navigation'
import { Conversation } from '~/state/conversation'
import { $connection, $preferences, $profileSwitching, $gatewayReady, requireGatewayReady, savePreferences } from '~/state/store'
import { createSessionSelection, type SessionSelection, type SelectionRequest } from '~/state/session-selection'
import { startGroupEngine, stopGroupEngine } from '~/features/groups/group-engine'

export const MINIMUM_CONTRACT = 6
const RETRY_DELAYS = [0, 500, 1_500, 3_000, 5_000]

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
  private disposed = false
  private activeListener?: AppLifecycleHandle
  private unsubscribeEvents?: () => void
  private unsubscribeState?: () => void
  private unsubscribeOwner?: () => void
  private unsubscribeNetwork?: () => void
  private stopNetworkObservation?: () => void
  private recovery: Promise<void> | null = null

  constructor(
    private readonly connection: HermesConnectionPlugin = HermesConnection,
    gateway?: GatewayTransport
  ) {
    this.transport = gateway ?? new RemoteGateway(connection)
    this.runtime = new SessionRuntime(this.transport, {
      minimumContract: MINIMUM_CONTRACT,
      retryDelays: RETRY_DELAYS,
      sessionSource: isNativeIOS() ? 'ios' : 'mobile',
      onAuthenticationFailure: error => this.applyConnectionError(error)
    })
    this.gateway = createGuardedGateway(this.runtime)
    this.conversation = new Conversation(this.runtime)
    this.selection = createSessionSelection({
      runtime: this.runtime,
      conversation: this.conversation,
      sessionsApi: scope => this.sessionsApi(scope)
    })
    this.subscribeRuntime()
  }

  async initialize() {
    const lifecycle = ++this.lifecycleGeneration
    const wasDisposed = this.disposed
    this.disposed = false
    this.appBackgrounded = false
    if (wasDisposed) this.subscribeRuntime()
    this.unsubscribeNetwork?.()
    this.stopNetworkObservation?.()
    this.stopNetworkObservation = observeNetworkStatus()
    this.unsubscribeNetwork = $networkStatus.listen(({ status }) => {
      if (status === 'offline') this.suspendTransport()
      else if (status === 'online' && this.canRecover() && $connection.get().phase !== 'connected') void this.retryConnection()
    })
    await this.activeListener?.remove()
    const listener = await observeAppLifecycle(({ isActive }) => {
      if (lifecycle !== this.lifecycleGeneration || this.disposed) return
      if (isActive) {
        this.appBackgrounded = false
        if (this.canRecover() && $connection.get().phase !== 'connected') void this.retryConnection()
      } else {
        this.appBackgrounded = true
        this.suspendTransport()
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
      $connection.set({ ...$connection.get(), error: null, phase: 'connecting', workspaceAvailable: false })
      lockDraftOwner()
      await this.teardownGatewayScope()
    }
    savePreferences({ remoteURL: configured.remoteURL })
    const { authMode, status } = await this.connection.probe()
    savePreferences({ authMode })
    $connection.set({ ...$connection.get(), authMode, error: null, errorKind: null, phase: 'disconnected', status })
    if (authMode === 'interactive') {
      try {
        await this.connection.request({ path: '/api/auth/me' })
      } catch (error) {
        this.applyConnectionError(error)
        return
      }
    }
    return this.connect()
  }

  async connect() {
    const generation = ++this.reconnectGeneration
    $connection.set({ ...$connection.get(), error: null, phase: 'connecting' })
    let restored
    let scope = currentGatewayScope()
    try {
      const preparation = await this.prepareDraftOwner()
      if (!this.isCurrentReconnect(generation)) return
      scope = currentGatewayScope()
      restored = await this.selection.restore(
        stored => this.runtime.open({ profile: scope.profile, storedSessionId: stored, missingTargetPolicy: this.savedTargetPolicy(stored, scope) }, async () => preparation),
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
    try {
      if (restored.kind === 'published') await this.conversation.reconcileHistory(scope)
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope) || $chat.get().availability !== 'live') return
      $connection.set({ ...$connection.get(), authMode, error: null, errorKind: null, workspaceAvailable: true, phase: 'connected', status })
      this.installGroupEngine(scope)
      await this.selection.refreshSessions(scope).catch(() => undefined)
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
    const historyCleared = transcriptCache.clearOwner($draftOwner.get())
    const draftsCleared = chatDrafts.clearOwner()
    lockDraftOwner()
    this.invalidateReconnect()
    $connection.set({ ...$connection.get(), error: null, phase: 'disconnected', workspaceAvailable: false })
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
    if (!draftsCleared || !historyCleared) {
      const message = 'Local draft or saved conversation removal could not be confirmed. Clear this site’s data before sharing the device.'
      $connection.set({ ...$connection.get(), phase: 'disconnected', error: message })
      throw new Error(message, { cause: logoutError })
    }
    if (logoutError) {
      $connection.set({ ...$connection.get(), phase: 'disconnected', error: 'Disconnected locally. Gateway sign out could not be confirmed. Reconnect to finish signing out.' })
      throw logoutError
    }
  }

  async switchProfile(profile: null | string) {
    if (profile === $preferences.get().profile) return
    if (!$gatewayReady.get()) return this.openProfile(profile)
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
    requireGatewayReady()
    const outcome = await this.selectRemote({ kind: 'create' })
    if (!outcome) return
  }

  async resumeSession(storedSessionId: string) {
    if (!$gatewayReady.get()) {
      const cached = transcriptCache.read({ owner: $draftOwner.get(), profile: $preferences.get().profile, storedSessionId })
      if (!cached) throw new GatewayError('This conversation is not saved on this device.', { kind: 'validation' })
      await this.selectCached(cached)
      return
    }
    return this.selectRemote({ kind: 'resume', storedSessionId })
  }

  async openProfile(profile: null | string) {
    if (!$gatewayReady.get()) {
      const cached = transcriptCache.latest($draftOwner.get(), profile)
      if (!cached) throw new GatewayError('No conversation for this bot is saved on this device.', { kind: 'validation' })
      return this.selectCached(cached)
    }
    const switched = profile !== $preferences.get().profile
    if (switched) await this.switchProfile(profile)
    return this.selectRemote({ kind: 'latest', freshen: !switched })
  }

  async refreshSessions(scope: CurrentGatewayScope = currentGatewayScope()) {
    requireGatewayReady()
    await this.selection.refreshSessions(scope)
  }

  async loadMoreSessions() {
    requireGatewayReady()
    await this.selection.loadMoreSessions()
  }

  async renameSession(storedSessionId: string, title: string) {
    requireGatewayReady()
    await this.selection.renameSession(storedSessionId, title)
  }

  async deleteSession(storedSessionId: string) {
    requireGatewayReady()
    await this.selection.deleteSession(storedSessionId)
  }

  async archiveSession(storedSessionId: string) {
    requireGatewayReady()
    await this.selection.archiveSession(storedSessionId)
  }

  async branchSession() {
    requireGatewayReady()
    await this.selectRemote({ kind: 'branch' })
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
    this.unsubscribeOwner?.()
    this.unsubscribeOwner = undefined
    this.unsubscribeNetwork?.()
    this.stopNetworkObservation?.()
    $connection.set({ ...$connection.get(), workspaceAvailable: false, phase: 'disconnected' })
    lockDraftOwner()
    this.conversation.reset()
    this.runtime.dispose()
    void this.activeListener?.remove()
  }

  private async prepareDraftOwner() {
    const generation = this.reconnectGeneration
    const gateway = $preferences.get().remoteURL
    const preparation = await this.connection.probe()
    let identity: unknown = null
    try {
      identity = (await this.connection.request({ path: '/api/auth/me' })).body
    } catch (error) {
      const classified = classifyGatewayError(error)
      // Some token/no-auth gateways do not expose a principal. Those modes remain memory-only.
      if (preparation.authMode === 'interactive' || classified.kind === 'auth' && $draftOwner.get().principal !== null || !['auth', 'unsupported'].includes(classified.kind)) throw error
    }
    if (generation !== this.reconnectGeneration || gateway !== $preferences.get().remoteURL || this.disposed) return preparation
    const previous = $draftOwner.get()
    const changed = previous.gateway !== gateway || previous.principal !== draftPrincipal(identity) || previous.locked
    if (changed && (previous.gateway || previous.principal || previous.locked)) {
      $connection.set({ ...$connection.get(), workspaceAvailable: false })
      this.selection.invalidate()
      stopGroupEngine()
      this.runtime.close()
      clearGatewayQueries()
      this.clearForegroundScope()
    }
    // Publish the newly verified owner only after the previous private view is gone.
    verifyDraftOwner(gateway, identity)
    return preparation
  }

  private async restoreBrowserConnection() {
    try {
      const { authMode, status } = await this.connection.probe()
      savePreferences({ authMode })
      $connection.set({ ...$connection.get(), authMode, error: null, errorKind: null, phase: 'connecting', status })
      if (authMode === 'interactive') {
        try {
          await this.connection.request({ path: '/api/auth/me' })
        } catch (error) {
          if (classifyGatewayError(error).kind === 'auth') {
            lockDraftOwner()
            $connection.set({ ...$connection.get(), authMode, error: null, phase: 'disconnected', status, workspaceAvailable: false })
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

  private async selectRemote(request: SelectionRequest) {
    requireGatewayReady()
    const scope = currentGatewayScope()
    try { return await this.selection.select(request) }
    catch (error) {
      const classified = classifyGatewayError(error)
      if (isCurrentGatewayScope(scope) && (classified.kind === 'auth' || classified.kind === 'unsupported' || $chat.get().availability === 'cached' || $chat.get().availability === 'synchronizing')) this.applyConnectionError(error)
      throw error
    }
  }

  private savedTargetPolicy(stored: string | null, scope: CurrentGatewayScope): 'resume-only' | 'create' {
    if (!stored) return 'create'
    const selected = $chat.get().storedSessionId === stored
    const cached = transcriptCache.read({ owner: $draftOwner.get(), profile: scope.profile, storedSessionId: stored })
    return selected || cached ? 'resume-only' : 'create'
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
      (method, params, options) => this.gateway.rpc(method, params, options),
      scope.connectionKey
    )
  }

  private subscribeRuntime() {
    this.unsubscribeOwner = $draftOwner.listen(owner => {
      if (!owner.locked || this.disposed || this.logoutInProgress) return
      this.invalidateReconnect()
      $connection.set({ ...$connection.get(), phase: 'disconnected', workspaceAvailable: false })
      stopGroupEngine()
      clearGatewayQueries()
      this.runtime.close()
      this.clearForegroundScope()
    })
    this.unsubscribeEvents = this.transport.subscribe(event => {
      if (this.disposed || this.appBackgrounded || $draftOwner.get().locked) return
      this.conversation.onGatewayEvent(event)
    })
    this.unsubscribeState = this.transport.subscribeState(state => {
      if (state === 'closed' && !this.disposed && !this.appBackgrounded && !this.logoutInProgress && $connection.get().phase === 'connected') {
        this.suspendTransport()
        if (this.canRecover()) void this.retryConnection()
      }
    })
  }

  private async reconnect(reconcile: boolean) {
    if (this.disposed) return
    const generation = ++this.reconnectGeneration
    let scope = currentGatewayScope()
    const hasCachedSession = $connection.get().workspaceAvailable
    this.conversation.suspend()
    $connection.set({
      ...$connection.get(),
      error: null,
      phase: hasCachedSession ? 'reconnecting' : 'connecting'
    })
    try {
      await this.prepareDraftOwner()
      if (!this.isCurrentReconnect(generation)) return
      scope = currentGatewayScope()
      const restored = await this.selection.restore(
        stored => this.runtime.reopen({ profile: scope.profile, storedSessionId: stored, missingTargetPolicy: this.savedTargetPolicy(stored, scope) }),
        () => this.isCurrentReconnect(generation)
      )
      if (!restored) return
      if (restored.kind === 'published' && reconcile) await this.conversation.reconcileHistory(scope)
      if (!this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      if ($chat.get().availability !== 'live') return
      $connection.set({ ...$connection.get(), error: null, errorKind: null, workspaceAvailable: true, phase: 'connected' })
      this.installGroupEngine(scope)
      await this.selection.refreshSessions(scope).catch(() => undefined)
    } catch (error) {
      const classified = classifyGatewayError(error)
      if (classified.kind === 'aborted' || !this.isCurrentReconnect(generation) || !isCurrentGatewayScope(scope)) return
      this.applyConnectionError(error)
    }
  }

  private applyConnectionError(error: unknown) {
    this.invalidateReconnect()
    const classified = classifyGatewayError(error)
    $connection.set({ ...$connection.get(), phase: 'error', errorKind: classified.kind })
    this.conversation.suspend()
    stopGroupEngine()
    this.runtime.close()
    if (classified.kind === 'unsupported') {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'unsupported' })
    } else if (classified.kind === 'auth') {
      lockDraftOwner()
      $connection.set({ ...$connection.get(), error: 'Your Hermes session expired. Sign in again.', phase: 'error' })
    } else {
      $connection.set({ ...$connection.get(), error: classified.message, phase: 'error' })
    }
  }

  private clearForegroundScope() {
    this.conversation.reset()
    this.selection.resetSessionList()
  }

  retryConnection(): Promise<void> {
    if (this.recovery) return this.recovery
    if (!this.canRecover()) return Promise.resolve()
    const recovery = this.reconnect(true).finally(() => { if (this.recovery === recovery) this.recovery = null })
    this.recovery = recovery
    return recovery
  }

  private canRecover() {
    return !this.disposed && !this.appBackgrounded && !this.logoutInProgress && Boolean($preferences.get().remoteURL)
      && !$draftOwner.get().locked && $networkStatus.get().status !== 'offline' && $connection.get().errorKind !== 'auth' && $connection.get().phase !== 'unsupported'
  }

  private suspendTransport() {
    const current = $connection.get()
    this.invalidateReconnect()
    $connection.set({ ...current, phase: current.phase === 'connected' || current.workspaceAvailable && current.phase !== 'error' ? 'reconnecting' : current.phase })
    this.conversation.suspend()
    stopGroupEngine()
    void cancelGatewayQueries()
    this.runtime.close()
  }

  private async selectCached(snapshot: CachedConversation) {
    const recovering = Boolean(this.recovery)
    chatDrafts.flush()
    this.suspendTransport()
    this.selection.invalidate()
    void cancelGatewayQueries()
    savePreferences({ profile: snapshot.profile })
    this.selection.selectCached(snapshot)
    if (recovering && this.canRecover()) void this.retryConnection()
  }

  private invalidateReconnect() {
    ++this.reconnectGeneration
    this.recovery = null
  }

  private isCurrentReconnect(generation: number) {
    return !this.disposed && generation === this.reconnectGeneration
  }
}