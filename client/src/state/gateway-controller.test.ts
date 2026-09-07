import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capacitorApp = vi.hoisted(() => ({ addListener: vi.fn() }))

vi.mock('@capacitor/app', () => ({ App: { addListener: capacitorApp.addListener } }))

import type { GatewayRequestOptions } from '~/gateway/gateway-port'
import { $chat, emptyChatState } from '~/state/conversation'
import { GatewayController, MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $connection, $preferences, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'
import { MemoryGateway } from '~/test/memory-gateway'

class ConnectionAwareGateway extends MemoryGateway {
  activeProfile: null | string = null
  connected = false

  override async connect(profile?: null | string, options: { signal?: AbortSignal } = {}): Promise<void> {
    await super.connect(profile, options)
    this.connected = true
    this.activeProfile = profile ?? null
  }

  override close(): void {
    this.connected = false
    this.activeProfile = null
    super.close()
  }

  override async rpc<T>(method: string, params: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (!this.connected) throw new Error('gateway not connected')
    return super.rpc<T>(method, params, options)
  }

  override async request<T>(options: GatewayRequestOptions) {
    if (!this.connected) throw new Error('gateway not connected')
    return super.request<T>(options)
  }
}

beforeEach(() => {
  capacitorApp.addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
  $chat.set(emptyChatState())
  $sessions.set([])
  $sessionsHasMore.set(false)
  $sessionsLoadingMore.set(false)
  $connection.set({ authMode: 'token', error: null, phase: 'disconnected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

afterEach(() => vi.restoreAllMocks())

describe('profile-scoped session mutations', () => {
  it('targets a selected profile for rename, archive, and delete', async () => {
    $preferences.set({ ...$preferences.get(), profile: 'client work/ios' })
    const requests: unknown[] = []
    const gateway = new MemoryGateway()
      .handle('/api/sessions/session%2F1', value => { requests.push(value); return {} })
      .handle('/api/sessions/session%2F1?profile=client+work%2Fios', value => { requests.push(value); return {} })
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController({} as never, gateway)

    await controller.renameSession('session/1', 'Renamed')
    await controller.archiveSession('session/1')
    await controller.deleteSession('session/1')

    expect(requests).toEqual([
      expect.objectContaining({ body: { profile: 'client work/ios', title: 'Renamed' }, method: 'PATCH', path: '/api/sessions/session%2F1?profile=client+work%2Fios' }),
      expect.objectContaining({ body: { archived: true, profile: 'client work/ios' }, method: 'PATCH', path: '/api/sessions/session%2F1?profile=client+work%2Fios' }),
      expect.objectContaining({ method: 'DELETE', path: '/api/sessions/session%2F1?profile=client+work%2Fios' })
    ])
    controller.dispose()
  })

  it('addresses the default profile explicitly', async () => {
    const requests: unknown[] = []
    const gateway = new MemoryGateway()
      .handle('/api/sessions/session-1?profile=default', value => { requests.push(value); return {} })
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController({} as never, gateway)

    await controller.renameSession('session-1', 'Renamed')
    await controller.deleteSession('session-1')

    expect(requests).toEqual([
      expect.objectContaining({ body: { profile: 'default', title: 'Renamed' }, method: 'PATCH', path: '/api/sessions/session-1?profile=default' }),
      expect.objectContaining({ method: 'DELETE', path: '/api/sessions/session-1?profile=default' })
    ])
    expect(gateway.calls.filter(call => call.kind === 'rpc').map(call => call.value)).toEqual([
      { limit: 30, profile: 'default' },
      { limit: 30, profile: 'default' }
    ])
    controller.dispose()
  })
})

describe('incremental session loading', () => {
  it('starts with a bounded session list and expands it on demand', async () => {
    const gateway = new MemoryGateway().handle('session.list', params => {
      const limit = (params as { limit: number }).limit
      return {
        sessions: Array.from({ length: limit === 30 ? 30 : 31 }, (_, index) => ({ id: `session-${index}` }))
      }
    })
    const controller = new GatewayController({} as never, gateway)

    await controller.refreshSessions()
    expect($sessions.get()).toHaveLength(30)
    expect($sessionsHasMore.get()).toBe(true)

    await controller.loadMoreSessions()
    expect($sessions.get()).toHaveLength(31)
    expect($sessionsHasMore.get()).toBe(false)
    expect(gateway.calls.filter(call => call.method === 'session.list').map(call => call.value)).toEqual([
      { limit: 30, profile: 'default' },
      { limit: 60, profile: 'default' }
    ])
    controller.dispose()
  })
})

describe('profile switching', () => {
  it('clears foreground state before reconnecting the selected profile', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'old-runtime', storedSessionId: 'old-stored' })
    $sessions.set([{ id: 'old-stored', message_count: 1, preview: '', source: 'ios', started_at: 1, title: 'Old' }])
    const controller = new GatewayController({} as never)
    const close = vi.spyOn(controller.gateway, 'close')
    const connect = vi.spyOn(controller, 'connect').mockResolvedValue()

    await controller.switchProfile('work')

    expect(close).toHaveBeenCalledOnce()
    expect($preferences.get().profile).toBe('work')
    expect($chat.get().runtimeSessionId).toBeNull()
    expect($sessions.get()).toEqual([])
    expect(connect).toHaveBeenCalledOnce()
    controller.dispose()
  })
})

describe('connection restoration', () => {
  it('restores transport-state observation when StrictMode reinitializes the controller', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-new' }))
      .handle('session.list', () => ({ sessions: [] }))
      .handle('session.resume', () => ({ info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'stored-1' }, session_id: 'runtime-1' }))
      .handle('session.history', () => ({ messages: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    controller.dispose()
    await controller.initialize()
    expect($connection.get().phase).toBe('connected')

    gateway.close()

    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect(gateway.calls.filter(call => call.kind === 'connect')).toHaveLength(3)
    expect(gateway.connected).toBe(true)
    controller.dispose()
  })

  it('reconnects when the foreground transport drops after being connected', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-new' }))
      .handle('session.history', () => ({ messages: [] }))
      .handle('session.list', () => ({ sessions: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    expect($connection.get().phase).toBe('connected')

    gateway.close()

    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect(gateway.calls.filter(call => call.kind === 'connect')).toHaveLength(2)
    await expect(controller.newSession()).resolves.toBeUndefined()
    controller.dispose()
  })

  it('retains the cached session while an intentional background close reconnects', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT },
        messages: [{ content: 'restored', role: 'assistant' }],
        session_id: 'runtime-restored',
        session_key: 'stored-1'
      }))
      .handle('/api/sessions/stored-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ content: 'reconciled', role: 'assistant' }],
        pagination: { limit: 80, offset: 0, returned: 1 }
      }))
      .handle('session.list', () => ({ sessions: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    expect($connection.get().phase).toBe('connected')
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-restored', storedSessionId: 'stored-1' })

    let releaseReconnect!: () => void
    const reconnectGate = new Promise<void>(resolve => { releaseReconnect = resolve })
    const originalConnect = gateway.connect.bind(gateway)
    vi.spyOn(gateway, 'connect').mockImplementationOnce(async (profile, options) => {
      await reconnectGate
      return originalConnect(profile, options)
    })
    const lifecycleHandler = capacitorApp.addListener.mock.calls[0]?.[1] as ((state: { isActive: boolean }) => void)

    lifecycleHandler({ isActive: false })
    expect($connection.get().phase).toBe('reconnecting')
    expect($chat.get().runtimeSessionId).toBe('runtime-restored')
    expect($chat.get().messages).toEqual([{ content: 'reconciled', id: 'history-0', role: 'assistant', streaming: false }])

    lifecycleHandler({ isActive: true })
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())
    expect($connection.get().phase).toBe('reconnecting')
    expect($chat.get().runtimeSessionId).toBe('runtime-restored')

    releaseReconnect()
    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect($chat.get().messages).toEqual([{ content: 'reconciled', id: 'history-0', role: 'assistant', streaming: false }])
    controller.dispose()
  })

  it('lets the latest foreground reconnect win when resume fires twice', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    let createCount = 0
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT },
        session_id: `runtime-${++createCount}`
      }))
      .handle('session.history', () => ({ messages: [] }))
      .handle('session.list', () => ({ sessions: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    let releaseFirst!: () => void
    let firstSettled = false
    const firstReconnect = new Promise<void>(resolve => { releaseFirst = resolve })
    const originalConnect = gateway.connect.bind(gateway)
    const connect = vi.spyOn(gateway, 'connect').mockImplementationOnce(async (profile, options) => {
      try {
        await firstReconnect
        return await originalConnect(profile, options)
      } finally {
        firstSettled = true
      }
    })
    const lifecycleHandler = capacitorApp.addListener.mock.calls[0]?.[1] as ((state: { isActive: boolean }) => void)

    lifecycleHandler({ isActive: false })
    lifecycleHandler({ isActive: true })
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    lifecycleHandler({ isActive: true })

    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect($chat.get().runtimeSessionId).toBe('runtime-2')

    releaseFirst()
    await vi.waitFor(() => expect(firstSettled).toBe(true))
    expect($connection.get().phase).toBe('connected')
    controller.dispose()
  })

  it('surfaces authentication failure after a foreground reconnect', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    let createCount = 0
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => {
        if (++createCount === 1) return { info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-initial' }
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      })
      .handle('session.list', () => ({ sessions: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    const lifecycleHandler = capacitorApp.addListener.mock.calls[0]?.[1] as ((state: { isActive: boolean }) => void)
    lifecycleHandler({ isActive: false })
    lifecycleHandler({ isActive: true })

    await vi.waitFor(() => expect($connection.get().phase).toBe('error'))
    expect($connection.get().error).toBe('Your Hermes session expired. Sign in again.')

    lifecycleHandler({ isActive: false })
    lifecycleHandler({ isActive: true })
    expect($connection.get().phase).toBe('connecting')
    await vi.waitFor(() => expect($connection.get().phase).toBe('error'))
    controller.dispose()
  })

  it('does not let a foreground event undo an in-progress logout', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    let releaseLogout!: () => void
    const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve })
    const connection = {
      logout: vi.fn(() => logoutGate),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-initial' }))
      .handle('session.list', () => ({ sessions: [] })) as ConnectionAwareGateway
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()
    const lifecycleHandler = capacitorApp.addListener.mock.calls[0]?.[1] as ((state: { isActive: boolean }) => void)
    const signingOut = controller.logout()
    await vi.waitFor(() => expect(connection.logout).toHaveBeenCalledOnce())

    lifecycleHandler({ isActive: true })
    expect($connection.get().phase).toBe('disconnected')

    releaseLogout()
    await signingOut
    expect($connection.get().phase).toBe('disconnected')
    expect($chat.get().runtimeSessionId).toBeNull()
    expect($sessions.get()).toEqual([])
    expect(gateway.calls.filter(call => call.kind === 'connect')).toHaveLength(1)
    controller.dispose()
  })

  it('opens a fresh session when a saved session no longer exists', async () => {
    $chat.set({ ...emptyChatState(), storedSessionId: 'deleted-session' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new MemoryGateway()
      .handle('session.resume', () => { throw new Error('session not found') })
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-new' }))
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()

    expect($connection.get()).toMatchObject({ error: null, phase: 'connected' })
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-new', storedSessionId: null })
    controller.dispose()
  })

  it('does not report connected when the profile session refresh fails', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-new' }))
      .handle('session.list', () => { throw new Error('session list unavailable') })
    const controller = new GatewayController(connection as never, gateway)

    await expect(controller.connect()).rejects.toThrow('session list unavailable')

    expect($connection.get()).toMatchObject({ phase: 'error' })
    expect($connection.get().error).toContain('session list unavailable')
    controller.dispose()
  })

  it('does not publish a session list after the captured profile changes mid-connect', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    let releaseList!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-default' }))
      .handle('session.list', params => {
        expect(params).toMatchObject({ limit: 30, profile: 'default' })
        return listGate.then(() => ({ sessions: [{ id: 'default-session' }] }))
      })
    const controller = new GatewayController(connection as never, gateway)

    const connecting = controller.connect()
    await vi.waitFor(() => expect(gateway.calls.some(call => call.kind === 'rpc' && call.method === 'session.list')).toBe(true))
    $preferences.set({ ...$preferences.get(), profile: 'work' })
    releaseList()
    await connecting

    expect($sessions.get()).toEqual([])
    expect($connection.get().phase).toBe('connecting')
    controller.dispose()
  })

  it('opens the selected profile after a delayed connection is superseded', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    let releaseInitial!: () => void
    const initialGate = new Promise<void>(resolve => { releaseInitial = resolve })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
    const originalConnect = gateway.connect.bind(gateway)
    let delayInitial = true
    const connect = vi.spyOn(gateway, 'connect').mockImplementation(async (profile, options = {}) => {
      if (delayInitial) {
        delayInitial = false
        await initialGate
      }
      return originalConnect(profile, options)
    })
    gateway
      .handle('session.create', params => {
        const profile = (params as { profile: string }).profile
        return { info: { desktop_contract: MINIMUM_CONTRACT }, session_id: `runtime-${profile}` }
      })
      .handle('session.list', params => ({ sessions: [{ id: `${(params as { profile: string }).profile}-session` }] }))
    const controller = new GatewayController(connection as never, gateway)

    const initialConnect = controller.connect()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())

    const switching = controller.switchProfile('work')
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2))
    await switching

    expect(connect.mock.calls.map(([profile]) => profile ?? null)).toEqual([null, 'work'])
    expect(gateway.activeProfile).toBe('work')
    expect($preferences.get().profile).toBe('work')
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-work', storedSessionId: null })
    expect($sessions.get()).toEqual([{ id: 'work-session' }])

    releaseInitial()
    await initialConnect
    expect(gateway.activeProfile).toBe('work')
    expect($chat.get().runtimeSessionId).toBe('runtime-work')
    controller.dispose()
  })
})

describe('conversation delegation', () => {
  it('publishes the opened session through the conversation when connecting', async () => {
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new MemoryGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-open' }))
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()

    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-open', storedSessionId: null })
    controller.dispose()
  })
})

describe('session selection lifecycle', () => {
  it('does not let a slower session selection replace a newer one', async () => {
    let finishFirst: ((value: unknown) => void) | undefined
    const first = new Promise(resolve => { finishFirst = resolve })
    const gateway = new MemoryGateway().handle('session.resume', params => {
      const sessionId = (params as { session_id: string }).session_id
      if (sessionId === 'first') return first
      return { info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: sessionId }, session_id: `runtime-${sessionId}` }
    }).handle('/api/sessions/second/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({ messages: [] }))
    const controller = new GatewayController({} as never, gateway)

    const stale = controller.resumeSession('first')
    await controller.resumeSession('second')
    finishFirst?.({ info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'first' }, session_id: 'runtime-first' })
    await stale

    expect($chat.get().storedSessionId).toBe('second')
    controller.dispose()
  })

  it('unsubscribes from gateway events when disposed', () => {
    const gateway = new MemoryGateway()
    const controller = new GatewayController({} as never, gateway)
    controller.dispose()

    gateway.emit({ type: 'message.start' })

    expect($chat.get().running).toBe(false)
  })
})

describe('backend compatibility', () => {
  it('accepts baseline and unversioned legacy gateways', async () => {
    let calls = 0
    const gateway = new MemoryGateway().handle('session.create', () => ++calls === 1
      ? { info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-baseline' }
      : { info: {}, session_id: 'runtime-unversioned' })
    const controller = new GatewayController({} as never, gateway)

    await controller.newSession()
    expect($chat.get()).toMatchObject({ contractVersion: MINIMUM_CONTRACT, runtimeSessionId: 'runtime-baseline' })

    await controller.newSession()
    expect($chat.get()).toMatchObject({ contractVersion: null, runtimeSessionId: 'runtime-unversioned' })
    controller.dispose()
  })

  it('rejects a pre-contract-6 gateway and accepts the minimum supported contract', async () => {
    let calls = 0
    const gateway = new MemoryGateway().handle('session.create', () => ++calls === 1
      ? { info: { desktop_contract: 5 }, session_id: 'runtime-old' }
      : { info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-current' })
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.newSession()).rejects.toThrow(/too old/i)
    expect($chat.get().runtimeSessionId).toBeNull()

    await expect(controller.newSession()).resolves.toBeUndefined()
    expect($chat.get()).toMatchObject({ contractVersion: MINIMUM_CONTRACT, runtimeSessionId: 'runtime-current' })
    controller.dispose()
  })

  it('requires a runtime session identity from unversioned gateways', async () => {
    const gateway = new MemoryGateway().handle('session.create', () => ({ info: {} }))
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.newSession()).rejects.toMatchObject({ kind: 'validation' })
    expect($chat.get().runtimeSessionId).toBeNull()
    controller.dispose()
  })

  it.each(['unknown', null, [6], true])('fails closed when the gateway contract marker is malformed: %j', async marker => {
    const gateway = new MemoryGateway().handle('session.create', () => ({
      info: { desktop_contract: marker },
      session_id: 'runtime-unknown'
    }))
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.newSession()).rejects.toThrow(/too old/i)
    expect($chat.get().runtimeSessionId).toBeNull()
    controller.dispose()
  })
})

describe('authentication lifecycle', () => {
  it('connects after native OAuth succeeds and preserves native login errors', async () => {
    const identity = {
      display_name: 'Mobile User', email: 'mobile@example.com', expires_at: 1,
      org_id: 'org', provider: 'stub', user_id: 'user'
    }
    const login = vi.fn().mockResolvedValue(identity)
    const connect = vi.spyOn(GatewayController.prototype, 'connect').mockResolvedValue()
    const controller = new GatewayController({ login } as never)

    await controller.login('stub')
    expect(login).toHaveBeenCalledWith({ provider: 'stub' })
    expect(connect).toHaveBeenCalledOnce()

    login.mockRejectedValueOnce(new Error('Sign in was cancelled.'))
    await expect(controller.login('stub')).rejects.toThrow('cancelled')
    expect(connect).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('uses the unchanged password-login bridge before connecting', async () => {
    const passwordLogin = vi.fn().mockResolvedValue({})
    const connect = vi.spyOn(GatewayController.prototype, 'connect').mockResolvedValue()
    const controller = new GatewayController({ passwordLogin } as never)
    await controller.passwordLogin('local', 'user', 'secret')
    expect(passwordLogin).toHaveBeenCalledWith({ password: 'secret', provider: 'local', username: 'user' })
    expect(connect).toHaveBeenCalledOnce()
    controller.dispose()
  })
})
