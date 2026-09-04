import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capacitorApp = vi.hoisted(() => ({ addListener: vi.fn() }))

vi.mock('@capacitor/app', () => ({ App: { addListener: capacitorApp.addListener } }))

import type { GatewayRequestOptions } from '~/gateway/gateway-port'
import { GatewayController, isReauthenticationError, MINIMUM_CONTRACT, toTranscript } from '~/state/gateway-controller'
import { $chat, $connection, $preferences, $sessions } from '~/state/store'
import { emptyChatState } from '~/state/event-reducer'
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
  $connection.set({ authMode: 'token', error: null, phase: 'disconnected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
  localStorage.clear()
})

afterEach(() => vi.restoreAllMocks())

describe('session identity and history mapping', () => {
  it('maps backend history without conflating message, runtime, and durable identities', () => {
    const messages = toTranscript([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', reasoning: 'briefly' }
    ] as never)
    expect(messages).toEqual([
      { content: 'hello', id: 'history-0', reasoning: undefined, role: 'user', streaming: false },
      { content: 'hi', id: 'history-1', reasoning: 'briefly', role: 'assistant', streaming: false }
    ])
  })

  it('projects internal timeline rows as compact activity instead of user messages', () => {
    const messages = toTranscript([
      { role: 'user', content: '[ASYNC DELEGATION COMPLETE — deleg_typed]\nagent result', display_kind: 'async_delegation_complete', display_metadata: { task_count: 1 }, row_id: 39 },
      { role: 'user', content: '[ASYNC DELEGATION BATCH COMPLETE — deleg_legacy]\nA background fan-out of 3 subagent(s) you dispatched earlier has finished. All ran in parallel and waited on each other; their consolidated results are below.', row_id: 40 },
      { role: 'user', content: 'internal handoff', display_kind: 'hidden', row_id: 41 },
      { role: 'user', content: 'switch payload', display_kind: 'model_switch', row_id: 42 }
    ] as never)

    expect(messages).toEqual([
      { content: '1 background agent finished', displayKind: 'async_delegation_complete', id: 'history-row-39', reasoning: undefined, role: 'system', rowId: 39, streaming: false },
      { content: '3 background agents finished', displayKind: 'async_delegation_complete', id: 'history-row-40', reasoning: undefined, role: 'system', rowId: 40, streaming: false },
      { content: 'model changed', displayKind: 'model_switch', id: 'history-row-42', reasoning: undefined, role: 'system', rowId: 42, streaming: false }
    ])
  })

  it('hydrates the current gateway projection and keeps durable row identity separate', () => {
    const messages = toTranscript([
      { role: 'user', content: 'model-only', display_content: 'visible', row_id: 41, text: 'fallback' },
      { role: 'assistant', content: null, reasoning_content: 'carefully', text: 'answer' },
      { role: 'tool', content: null, context: 'terminal output', id: 43 },
      { role: 'assistant', content: { type: 'image' }, text: 'must not stringify malformed content' }
    ] as never)

    expect(messages).toEqual([
      { content: 'visible', id: 'history-row-41', reasoning: undefined, role: 'user', rowId: 41, streaming: false },
      { content: 'answer', id: 'history-1', reasoning: 'carefully', role: 'assistant', streaming: false },
      { content: 'terminal output', id: 'history-row-43', reasoning: undefined, role: 'tool', rowId: 43, streaming: false },
      { content: '', id: 'history-3', reasoning: undefined, role: 'assistant', streaming: false }
    ])
  })
})

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
      { limit: 200, profile: 'default' },
      { limit: 200, profile: 'default' }
    ])
    controller.dispose()
  })
})

describe('prompt submission safety', () => {
  it('submits ordinary prompts without truncation parameters', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const controller = new GatewayController({} as never, gateway)

    await controller.send('  hello  ')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: { session_id: 'runtime-1', text: 'hello' } })
    controller.dispose()
  })

  it('queues active-turn prompts at the gateway instead of client memory', async () => {
    $chat.set({ ...emptyChatState(), running: true, runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const controller = new GatewayController({} as never, gateway)

    await controller.send('next task')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: {
      queued: true,
      session_id: 'runtime-1',
      text: 'next task'
    } })
    controller.dispose()
  })

  it('confirms a durable first-turn rewind by both ordinal and row id', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const controller = new GatewayController({} as never, gateway)

    await controller.retryFrom(0, 41, 'edited hello')

    expect(gateway.calls).toContainEqual({ kind: 'rpc', method: 'prompt.submit', value: {
      confirm_empty_truncate: true,
      confirm_truncate: true,
      session_id: 'runtime-1',
      text: 'edited hello',
      truncate_before_row_id: 41,
      truncate_before_user_ordinal: 0
    } })
    controller.dispose()
  })

  it('leaves chat retryable when prompt submission fails', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.send('hello')).rejects.toMatchObject({ kind: 'auth' })

    expect($chat.get()).toMatchObject({ error: 'Unauthorized', running: false, runtimeSessionId: 'runtime-1' })
    controller.dispose()
  })

  it('keeps a pending response when delivery fails', async () => {
    const pendingPrompt = { kind: 'approval' as const, payload: {}, requestId: 'request-1' }
    $chat.set({ ...emptyChatState(), pendingPrompt, runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('approval.respond', () => {
      throw new Error('Network disconnected')
    })
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.respond('yes')).rejects.toMatchObject({ kind: 'network' })

    expect($chat.get().pendingPrompt).toEqual(pendingPrompt)
    controller.dispose()
  })

  it('refuses to rewind without a durable row id', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const gateway = new MemoryGateway().handle('prompt.submit', () => ({}))
    const controller = new GatewayController({} as never, gateway)

    await expect(controller.retryFrom(1, undefined as never, 'unsafe')).rejects.toThrow(/durable message row/i)
    expect(gateway.calls).not.toContainEqual(expect.objectContaining({ method: 'prompt.submit' }))
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

    expect($connection.get().phase).toBe('disconnected')
    await expect(controller.resumeSession('stored-1')).rejects.toThrow('gateway not connected')
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
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'stored-1' },
        messages: [{ content: 'restored', role: 'assistant' }],
        session_id: 'runtime-restored'
      }))
      .handle('session.history', () => ({ messages: [{ content: 'reconciled', role: 'assistant' }] }))
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
    expect($chat.get().messages).toEqual([{ content: 'restored', id: 'history-0', role: 'assistant', streaming: false }])

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
        expect(params).toMatchObject({ limit: 200, profile: 'default' })
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

describe('session selection lifecycle', () => {
  it('does not let a slower session selection replace a newer one', async () => {
    let finishFirst: ((value: unknown) => void) | undefined
    const first = new Promise(resolve => { finishFirst = resolve })
    const gateway = new MemoryGateway().handle('session.resume', params => {
      const sessionId = (params as { session_id: string }).session_id
      if (sessionId === 'first') return first
      return { info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: sessionId }, session_id: `runtime-${sessionId}` }
    }).handle('session.history', () => ({ messages: [] }))
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
  it('recognizes native and HTTP authentication failures without treating network errors as logout', () => {
    expect(isReauthenticationError({ code: 'AUTH_REQUIRED', message: 'expired' })).toBe(true)
    expect(isReauthenticationError(new Error('Hermes returned HTTP 401.'))).toBe(true)
    expect(isReauthenticationError(new Error('Unauthorized'))).toBe(true)
    expect(isReauthenticationError(new Error('Network connection lost'))).toBe(false)
  })

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
