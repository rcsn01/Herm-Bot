import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capacitorApp = vi.hoisted(() => ({ addListener: vi.fn() }))

vi.mock('~/native/app-lifecycle', () => ({
  observeAppLifecycle: (handler: unknown) => capacitorApp.addListener('appStateChange', handler)
}))

import type { GatewayRequestOptions } from '~/gateway/gateway-port'
import { $workspacePolicy, dismissMenu, openMenu, resetWorkspacePolicy } from '~/navigation/workspace-navigation'
import { $chat, emptyChatState } from '~/state/conversation'
import { chatDrafts, emptyDraft } from '~/features/chat/chat-drafts'
import { localPrivacy } from '~/state/local-privacy'
import { $draftOwner, draftOwnerKey, verifyDraftOwner } from '~/state/draft-owner'
import { transcriptCache } from '~/state/transcript-cache'
import { sessionBookmarkKey } from '~/state/session-selection'
import { GatewayController, MINIMUM_CONTRACT } from '~/state/gateway-controller'
import { $groupChats, createGroupChat, sendToGroupChat } from '~/features/groups/group-engine'
import { $connection, $preferences, $profileSwitching, $sessions, $sessionsHasMore, $sessionsLoadingMore } from '~/state/store'
import { MemoryGateway as BaseMemoryGateway } from '~/test/memory-gateway'

// Newly created conversations also reconcile before readiness. Tests that do
// not customize history receive an authoritative empty page.
class MemoryGateway extends BaseMemoryGateway {
  constructor() { super(); this.handle('session.history', () => ({ messages: [] })) }
  override async request<T>(options: GatewayRequestOptions) {
    try { return await super.request<T>(options) }
    catch (error) {
      if (error instanceof Error && error.message === `No MemoryGateway handler for ${options.path}` && /^\/api\/sessions\/[^/]+\/messages\?/.test(options.path)) return { body: { messages: [] } as T, headers: {}, status: 200 }
      throw error
    }
  }
}
import { createTranscript } from '~/transcript/transcript'

const identityRequest = () => vi.fn().mockResolvedValue({ body: { org_id: 'test', user_id: 'user' }, status: 200, headers: {} })

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, reject, resolve }
}

function sessionReply(storedSessionId: string, title = 'Original') {
  return {
    info: { desktop_contract: MINIMUM_CONTRACT, title },
    session_id: `runtime-${storedSessionId}`,
    stored_session_id: storedSessionId
  }
}

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
  $profileSwitching.set(false)
  $connection.set({ authMode: 'token', error: null, errorKind: null, workspaceAvailable: false, phase: 'connected', status: null })
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://test.hermes', theme: 'system' })
  localStorage.clear()
  verifyDraftOwner('https://test.hermes', { org_id: 'test', user_id: 'user' })
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
      { include_hidden: true, limit: 30, profile: 'default' },
      { include_hidden: true, limit: 30, profile: 'default' }
    ])
    controller.dispose()
  })
})

describe('profile switching', () => {
  it('clears foreground state before reconnecting the selected profile', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'old-runtime', storedSessionId: 'old-stored' })
    $sessions.set([{ id: 'old-stored', message_count: 1, preview: '', source: 'ios', started_at: 1, title: 'Old' }])
    const transport = new MemoryGateway()
    const controller = new GatewayController({} as never, transport)
    const close = vi.spyOn(transport, 'close')
    const connect = vi.spyOn(controller, 'connect').mockResolvedValue()

    await controller.switchProfile('work')

    expect(close).toHaveBeenCalledOnce()
    expect($preferences.get().profile).toBe('work')
    expect($chat.get().runtimeSessionId).toBeNull()
    expect($sessions.get()).toEqual([])
    expect(connect).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('resets the menu/return policy together with the route stacks on teardown (Δ2)', async () => {
    const controller = new GatewayController({} as never)
    const connect = vi.spyOn(controller, 'connect').mockResolvedValue()

    resetWorkspacePolicy()
    openMenu()
    dismissMenu({ type: 'tab', tab: 'cron' })
    expect($workspacePolicy.get().returnOrigin).toBe('roster')

    await controller.switchProfile('work')

    expect($workspacePolicy.get()).toEqual({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
    expect(connect).toHaveBeenCalledOnce()
    controller.dispose()
  })

  it('restarts the group engine on the same connection key across a profile switch', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    let created = 0
    let resumes = 0
    const connection = { request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: `runtime-${++created}` }))
      .handle('session.list', () => ({ sessions: [] }))
      .handle('profiles.list', () => ({ profiles: [] }))
      .handle('prompt.submit', () => ({}))
      .handle('session.resume', params => {
        const { omit_messages: omit, session_id: sessionId } = params as { omit_messages?: boolean; session_id: string }
        if (omit) return { session_id: `runtime-of-${sessionId}`, session_key: 'stored-group-1' }
        resumes += 1
        return resumes === 1
          ? { messages: [] }
          : { messages: [{ role: 'assistant', content: 'on it' }] }
      })
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()

    // A room driven through the engine tags its session provenance with the
    // connection key (the configured remoteURL), and the member RPC addresses
    // the member's own profile.
    const room = createGroupChat('Crew', [{ name: 'ada' }], new Set())
    sendToGroupChat(room.key, [{ name: 'ada' }], 'hello', 't1')
    await vi.waitFor(() => {
      const stored = $groupChats.get()[room.key]
      expect(stored.sessionConnectionKey).toBe('https://gateway.test')
      expect(stored.sessions?.ada).toBe('stored-group-1')
    })
    const memberResume = gateway.calls.find(call => call.kind === 'rpc' && call.method === 'session.resume')
    expect((memberResume?.value as { profile?: string }).profile).toBe('ada')
    // The turn's poll runs on a 2s interval under real timers — wait past it
    // so the reply settles before the profile switch tears the lifecycle down.
    await vi.waitFor(() => expect($groupChats.get()[room.key].log.some(entry => entry.text === 'on it')).toBe(true), { timeout: 6000 })

    await controller.switchProfile('work')

    // Same remoteURL → same connection key: the engine restarted (a fresh
    // mirror pull proves the new lifecycle armed) and its startup sweep kept
    // the tagged session state for the next turn on this Gateway.
    await vi.waitFor(() =>
      expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'profiles.list').length).toBeGreaterThanOrEqual(2)
    )
    const after = $groupChats.get()[room.key]
    expect(after.sessionConnectionKey).toBe('https://gateway.test')
    expect(after.sessions?.ada).toBe('stored-group-1')
    expect(after.log.some(entry => entry.text === 'hello')).toBe(true)
    controller.dispose()
  })
})

describe('roster tap flow', () => {
  it('switches to the tapped profile and resumes its newest session', async () => {
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-switch' }))
      .handle('session.list', () => ({
        sessions: [
          { id: 'older', message_count: 1, preview: '', source: 'ios', started_at: 100, title: 'Older' },
          { id: 'newest', message_count: 2, preview: '', source: 'ios', started_at: 300, title: 'Newest' },
          { id: 'middle', message_count: 1, preview: '', source: 'ios', started_at: 200, title: 'Middle' }
        ]
      }))
      .handle('session.resume', params => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: (params as { session_id: string }).session_id },
        session_id: `runtime-${(params as { session_id: string }).session_id}`
      }))
      .handle('/api/sessions/newest/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=work', () => ({
        messages: [], pagination: { limit: 80, offset: 0, returned: 0 }
      }))
    const controller = new GatewayController({ request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) } as never, gateway)

    await controller.openProfile('work')

    const resumes = gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'session.resume')
    expect(resumes.map(call => (call.value as { session_id: string }).session_id)).toEqual(['newest'])
    expect((resumes[0]?.value as { profile: string }).profile).toBe('work')
    expect($chat.get().storedSessionId).toBe('newest')
    controller.dispose()
  })

  it('keeps the current profile connected without a redundant switch', async () => {
    $preferences.set({ authMode: 'token', profile: 'work', remoteURL: '', theme: 'system' })
    const gateway = new MemoryGateway()
      .handle('session.resume', params => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: (params as { session_id: string }).session_id },
        session_id: `runtime-${(params as { session_id: string }).session_id}`
      }))
      .handle('/api/sessions/newest/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=work', () => ({
        messages: [], pagination: { limit: 80, offset: 0, returned: 0 }
      }))
    const controller = new GatewayController({} as never, gateway)
    $sessions.set([{ id: 'newest', message_count: 1, preview: '', source: 'ios', started_at: 5, title: 'Newest' }])

    await controller.openProfile('work')

    expect(gateway.calls.filter(call => call.kind === 'connect')).toEqual([]) // no redundant switch
    expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'session.resume')
      .map(call => (call.value as { session_id: string }).session_id)).toEqual(['newest'])
    controller.dispose()
  })

  it('does not resume again when the profile switch already landed on the newest session', async () => {
    // A profile switch clears the foreground conversation; the scope bookmark
    // is what connect() restores from.
    localStorage.setItem(sessionBookmarkKey({ connectionKey: $preferences.get().remoteURL, profile: 'work' }), 'newest')
    const gateway = new ConnectionAwareGateway()
      .handle('session.resume', params => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: (params as { session_id: string }).session_id },
        session_id: `runtime-${(params as { session_id: string }).session_id}`
      }))
      .handle('session.list', () => ({ sessions: [{ id: 'newest', message_count: 1, preview: '', source: 'ios', started_at: 5, title: 'Newest' }] }))
      .handle('/api/sessions/newest/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=work', () => ({
        messages: [], pagination: { limit: 80, offset: 0, returned: 0 }
      }))
    const controller = new GatewayController({ request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) } as never, gateway)

    await controller.openProfile('work')

    // connect() resumed the stored session in passing; the warm tap must not re-resume or re-reconcile.
    expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'session.resume')
      .map(call => (call.value as { session_id: string }).session_id)).toEqual(['newest'])
    expect(gateway.calls.filter(call => call.kind === 'request' && String((call.value as { path: string }).path).includes('/api/sessions/newest/messages'))).toHaveLength(1)
    controller.dispose()
  })

  it('reports connected as soon as a session is selected, before the list loads', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    let releaseList!: () => void
    const listGate = new Promise<void>(resolve => { releaseList = resolve })
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-default' }))
      .handle('session.list', () => listGate.then(() => ({ sessions: [] })))
    const controller = new GatewayController({ request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) } as never, gateway)

    const connecting = controller.connect()
    await vi.waitFor(() => expect(gateway.calls.some(call => call.kind === 'rpc' && call.method === 'session.list')).toBe(true))
    expect($connection.get().phase).toBe('connected')

    releaseList()
    await connecting
    expect($connection.get().phase).toBe('connected')
    controller.dispose()
  })

  it('forwards and aborts the Group mirror request signal', async () => {
    let releaseProfiles!: (value: unknown) => void
    const profiles = new Promise<unknown>(resolve => { releaseProfiles = resolve })
    let mirrorSignal: AbortSignal | undefined
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-default' }))
      .handle('session.list', () => ({ sessions: [] }))
      .handle('profiles.list', (_params, options) => {
        mirrorSignal = options?.signal
        return profiles
      })
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()
    await vi.waitFor(() => expect(mirrorSignal).toBeDefined())
    expect(mirrorSignal?.aborted).toBe(false)

    controller.dispose()
    expect(mirrorSignal?.aborted).toBe(true)
    releaseProfiles({ profiles: [] })
    await Promise.resolve()
  })

  it('flags the profile switch while it is in flight and clears it afterwards', async () => {
    const controller = new GatewayController({} as never)
    let releaseConnect: (() => void) | null = null
    const connectSpy = vi.spyOn(controller, 'connect').mockImplementation(() => new Promise<void>(resolve => { releaseConnect = resolve }))

    const pending = controller.switchProfile('work')
    await vi.waitFor(() => expect(connectSpy).toHaveBeenCalled())
    expect($profileSwitching.get()).toBe(true)
    releaseConnect!()
    await pending
    expect($profileSwitching.get()).toBe(false)

    $connection.set({ ...$connection.get(), phase: 'connected' })
    vi.spyOn(controller, 'connect').mockRejectedValueOnce(new Error('gateway down'))
    await expect(controller.switchProfile('home')).rejects.toThrow('gateway down')
    expect($profileSwitching.get()).toBe(false)
    controller.dispose()
  })
})

describe('connection restoration', () => {
  it('rejects remote new-session work while initial history is not ready', async () => {
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const resumeStarted = deferred<void>()
    const oldResume = deferred<unknown>()
    const gateway = new ConnectionAwareGateway()
      .handle('session.resume', () => {
        expect(gateway.connected).toBe(true)
        resumeStarted.resolve()
        return oldResume.promise
      })
      .handle('session.create', () => sessionReply('new-session', 'New'))
      .handle('session.list', () => ({ sessions: [] }))
      .handle('profiles.list', () => ({ profiles: [] }))
      .handle('/api/sessions/new-session/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({ messages: [] }))
      .handle('/api/sessions/old-session/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ role: 'user', content: 'stale restore row' }]
      }))
    const controller = new GatewayController(connection as never, gateway)
    localStorage.setItem(sessionBookmarkKey(), 'old-session')

    const connecting = controller.connect()
    await resumeStarted.promise
    expect(gateway.connected).toBe(true)
    expect($connection.get().phase).toBe('connecting')

    await expect(controller.newSession()).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
    expect(localStorage.getItem(sessionBookmarkKey())).toBe('old-session')
    expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'session.create')).toHaveLength(0)

    oldResume.resolve({
      info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'old-session' },
      messages: [{ role: 'user', content: 'stale restore row' }],
      session_id: 'runtime-old-session',
      stored_session_id: 'old-session'
    })
    await connecting

    expect($connection.get()).toMatchObject({ authMode: 'token', error: null, phase: 'connected', status: { version: 'current' } })
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-old-session', storedSessionId: 'old-session', availability: 'live' })
    expect(localStorage.getItem(sessionBookmarkKey())).toBe('old-session')
    expect(gateway.calls.filter(call => call.kind === 'rpc' && call.method === 'session.list')).toHaveLength(1)
    expect(gateway.calls.some(call => call.kind === 'request' && String((call.value as { path: string }).path).includes('/api/sessions/old-session/messages'))).toBe(true)
    controller.dispose()
  })

  it('blocks new-session work throughout a pending reconnect', async () => {
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const resumeStarted = deferred<void>()
    const oldResume = deferred<unknown>()
    let resumeCount = 0
    const gateway = new ConnectionAwareGateway()
      .handle('session.resume', () => {
        resumeCount += 1
        expect(gateway.connected).toBe(true)
        if (resumeCount === 1) {
          return {
            info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'old-session' },
            session_id: 'runtime-old-session',
            stored_session_id: 'old-session'
          }
        }
        resumeStarted.resolve()
        return oldResume.promise
      })
      .handle('session.create', () => sessionReply('new-session', 'New'))
      .handle('session.list', () => ({ sessions: [] }))
      .handle('profiles.list', () => ({ profiles: [] }))
      .handle('/api/sessions/old-session/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ role: 'assistant', content: 'initial history' }]
      }))
      .handle('/api/sessions/new-session/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({ messages: [] }))
    const controller = new GatewayController(connection as never, gateway)
    localStorage.setItem(sessionBookmarkKey(), 'old-session')

    await controller.connect()
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-old-session', storedSessionId: 'old-session' })
    const historyCallsBeforeReconnect = gateway.calls.filter(call => call.kind === 'request' && String((call.value as { path: string }).path).includes('/api/sessions/')).length

    gateway.close()
    expect($connection.get().phase).toBe('reconnecting')
    await resumeStarted.promise
    expect($connection.get().phase).toBe('reconnecting')

    await expect(controller.newSession()).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-old-session', storedSessionId: 'old-session', availability: 'cached' })
    expect(localStorage.getItem(sessionBookmarkKey())).toBe('old-session')

    oldResume.resolve({
      info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'old-session' },
      messages: [{ role: 'user', content: 'stale reconnect row' }],
      session_id: 'runtime-old-session-reopened',
      stored_session_id: 'old-session'
    })
    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))

    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-old-session-reopened', storedSessionId: 'old-session', availability: 'live' })
    expect(localStorage.getItem(sessionBookmarkKey())).toBe('old-session')
    expect(gateway.calls.filter(call => call.kind === 'request' && String((call.value as { path: string }).path).includes('/api/sessions/')).length).toBe(historyCallsBeforeReconnect + 1)
    controller.dispose()
  })

  it('a cached latest tap supersedes a reconnect without remote history work', async () => {
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const resumeStarted = deferred<void>()
    const reopenedSession = deferred<unknown>()
    const warmHistory = deferred<{ messages: { role: string; content: string }[] }>()
    let resumeCount = 0
    let historyCount = 0
    const gateway = new ConnectionAwareGateway()
      .handle('session.resume', () => {
        resumeCount += 1
        if (resumeCount === 1) {
          return {
            info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'same-session' },
            session_id: 'runtime-before-reconnect',
            stored_session_id: 'same-session'
          }
        }
        resumeStarted.resolve()
        return reopenedSession.promise
      })
      .handle('session.list', () => ({
        sessions: [{ id: 'same-session', message_count: 1, preview: '', source: 'ios', started_at: 10, title: 'Same' }]
      }))
      .handle('profiles.list', () => ({ profiles: [] }))
      .handle('/api/sessions/same-session/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => {
        historyCount += 1
        if (historyCount === 2) return warmHistory.promise
        return { messages: [{ role: 'assistant', content: `history-${historyCount}` }] }
      })
    const controller = new GatewayController(connection as never, gateway)
    localStorage.setItem(sessionBookmarkKey(), 'same-session')

    await controller.connect()
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-before-reconnect', storedSessionId: 'same-session' })

    gateway.close()
    await resumeStarted.promise
    const warmTap = controller.openProfile(null)
    await warmTap
    expect(historyCount).toBe(1)
    expect($chat.get().availability).toBe('cached')
    expect($chat.get().runtimeSessionId).toBeNull()

    reopenedSession.resolve({
      info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'same-session' },
      session_id: 'runtime-after-reconnect',
      stored_session_id: 'same-session'
    })
    await vi.waitFor(() => expect(historyCount).toBe(2))
    expect($connection.get().phase).toBe('reconnecting')
    warmHistory.resolve({ messages: [{ role: 'assistant', content: 'confirmed recovered history' }] })
    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-after-reconnect', storedSessionId: 'same-session', availability: 'live' })
    expect($chat.get().transcript.entries.some(entry => entry.content === 'confirmed recovered history')).toBe(true)
    controller.dispose()
  })

  it('waits on the sign-in screen instead of opening a WebSocket for a fresh interactive browser', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: window.location.origin })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'interactive', status: { auth_required: true } }),
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }))
    }
    const gateway = new ConnectionAwareGateway()
    const controller = new GatewayController(connection as never, gateway)

    await controller.initialize()

    expect(connection.request).toHaveBeenCalledWith({ path: '/api/auth/me' })
    expect(gateway.calls.filter(call => call.kind === 'connect')).toEqual([])
    expect($connection.get()).toMatchObject({ authMode: 'interactive', error: null, phase: 'disconnected' })
    controller.dispose()
  })

  it('does not report disconnection while checking an existing browser session', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: window.location.origin })
    let rejectIdentity!: (error: unknown) => void
    const identity = new Promise<never>((_resolve, reject) => { rejectIdentity = reject })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'interactive', status: { auth_required: true } }),
      request: vi.fn().mockReturnValue(identity)
    }
    const controller = new GatewayController(connection as never, new ConnectionAwareGateway())

    const initialization = controller.initialize()
    await vi.waitFor(() => expect(connection.request).toHaveBeenCalled())
    expect($connection.get().phase).toBe('connecting')

    rejectIdentity(Object.assign(new Error('Unauthorized'), { status: 401 }))
    await initialization
    expect($connection.get().phase).toBe('disconnected')
    controller.dispose()
  })

  it('reports a non-authentication failure while restoring a browser session', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: window.location.origin })
    const connection = {
      probe: vi.fn().mockResolvedValue({ authMode: 'interactive', status: { auth_required: true } }),
      request: vi.fn().mockRejectedValue(new Error('proxy unavailable'))
    }
    const controller = new GatewayController(connection as never, new ConnectionAwareGateway())

    await controller.initialize()

    expect($connection.get()).toMatchObject({ error: expect.stringContaining('proxy unavailable'), phase: 'error' })
    controller.dispose()
  })

  it('restores transport-state observation when StrictMode reinitializes the controller', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
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
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
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
    await expect(controller.newSession()).resolves.toMatchObject({ session: { runtimeSessionId: 'runtime-new' } })
    controller.dispose()
  })

  it('retains the cached session while an intentional background close reconnects', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    $chat.set({ ...emptyChatState(), storedSessionId: 'stored-1' })
    const connection = {
      request: identityRequest(),
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
    expect($chat.get().transcript.entries).toEqual([{ author: 'assistant', content: 'reconciled', id: 'history-0', kind: 'message', reasoning: undefined, streaming: false }])

    lifecycleHandler({ isActive: true })
    await vi.waitFor(() => expect(gateway.connect).toHaveBeenCalledOnce())
    expect($connection.get().phase).toBe('reconnecting')
    expect($chat.get().runtimeSessionId).toBe('runtime-restored')

    releaseReconnect()
    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect($chat.get().transcript.entries).toEqual([{ author: 'assistant', content: 'reconciled', id: 'history-0', kind: 'message', reasoning: undefined, streaming: false }])
    controller.dispose()
  })

  it('coalesces repeated foreground recovery while the same target is pending', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
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
    expect(connect).toHaveBeenCalledOnce()
    expect($connection.get().phase).toBe('reconnecting')
    releaseFirst()
    await vi.waitFor(() => expect(firstSettled).toBe(true))
    await vi.waitFor(() => expect($connection.get().phase).toBe('connected'))
    expect($chat.get().runtimeSessionId).toBe('runtime-2')
    expect($connection.get().phase).toBe('connected')
    controller.dispose()
  })

  it('surfaces authentication failure after a foreground reconnect', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
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
    expect($connection.get().phase).toBe('error')
    expect($draftOwner.get().locked).toBe(true)
    expect($connection.get().workspaceAvailable).toBe(false)
    controller.dispose()
  })

  it('does not let a foreground event undo an in-progress logout', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    let releaseLogout!: () => void
    const logoutGate = new Promise<void>(resolve => { releaseLogout = resolve })
    const connection = {
      logout: vi.fn(() => logoutGate),
      request: identityRequest(),
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

  it('does not replace a missing cold-start bookmark with an exact saved snapshot', async () => {
    localStorage.setItem(sessionBookmarkKey(), 'deleted-session')
    transcriptCache.write({ owner: $draftOwner.get(), profile: null, storedSessionId: 'deleted-session' }, { title: 'Saved', source: null, startedAt: null, lastSyncedAt: 1, entries: [] })
    const connection = { request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) }
    const gateway = new MemoryGateway().handle('session.resume', () => { throw new Error('session not found') }).handle('session.create', () => sessionReply('substitute'))
    const controller = new GatewayController(connection as never, gateway)
    try {
      await expect(controller.connect()).rejects.toThrow('session not found')
      expect(gateway.calls.some(call => call.method === 'session.create')).toBe(false)
      expect(localStorage.getItem(sessionBookmarkKey())).toBe('deleted-session')
      expect($chat.get().storedSessionId).toBeNull()
    } finally { controller.dispose() }
  })

  it('opens a fresh session for a missing cold-start bookmark without preserved content', async () => {
    localStorage.setItem(sessionBookmarkKey(), 'deleted-session')
    const connection = {
      request: identityRequest(),
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

  it('keeps a reconciled conversation ready when session-list refresh fails', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-new' }))
      .handle('session.list', () => { throw new Error('session list unavailable') })
    const controller = new GatewayController(connection as never, gateway)

    await expect(controller.connect()).resolves.toBeUndefined()
    expect($connection.get()).toMatchObject({ phase: 'connected', error: null, workspaceAvailable: true })
    expect($chat.get().availability).toBe('live')
    controller.dispose()
  })

  it('does not publish a session list after the captured profile changes mid-connect', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    const connection = {
      request: identityRequest(),
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
    // The stale connect still reports its own scope connected; the captured
    // scope guard is what keeps the other profile's list unpublished.
    expect($connection.get().phase).toBe('connected')
    controller.dispose()
  })

  it('preserves a pending cold connection when an uncached profile is unavailable', async () => {
    $preferences.set({ ...$preferences.get(), remoteURL: 'https://gateway.test' })
    verifyDraftOwner('https://gateway.test', { org_id: 'test', user_id: 'user' })
    let releaseInitial!: () => void
    const initialGate = new Promise<void>(resolve => { releaseInitial = resolve })
    const connection = {
      request: identityRequest(),
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

    await expect(controller.switchProfile('work')).rejects.toThrow('No conversation for this bot is saved')
    expect(connect).toHaveBeenCalledOnce()
    expect($preferences.get().profile).toBeNull()
    releaseInitial()
    await initialConnect
    expect(gateway.activeProfile).toBeNull()
    expect($chat.get().runtimeSessionId).toBe('runtime-default')
    controller.dispose()
  })
})

describe('conversation delegation', () => {
  it('publishes the opened session through the conversation when connecting', async () => {
    const connection = {
      request: identityRequest(),
      probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } })
    }
    const gateway = new MemoryGateway()
      .handle('session.create', () => ({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-open' }))
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()

    expect($chat.get()).toMatchObject({ runtimeSessionId: 'runtime-open', storedSessionId: null })
    expect(gateway.calls.some(call => call.kind === 'rpc' && call.method === 'session.create')).toBe(true)
    controller.dispose()
  })
})

describe('transcript provenance', () => {
  const marker = '[IMPORTANT: You are running as a scheduled cron job. DELIVERY: report.]'

  it('passes selected session-list cron provenance into the transcript', async () => {
    $sessions.set([{ id: 'scheduled-1', message_count: 1, preview: marker, source: 'cron', started_at: 1, title: 'Job' }])
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'scheduled-1' },
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/scheduled-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ role: 'user', content: marker, row_id: 1 }]
      }))
    const controller = new GatewayController({} as never, gateway)

    await controller.resumeSession('scheduled-1')

    expect($chat.get().transcript.context.source).toBe('cron')
    expect($chat.get().transcript.entries[0].kind).toBe('cron-instructions')
    controller.dispose()
  })

  it('reclassifies a non-prefixed active session when refresh supplies cron source', async () => {
    $chat.set({ ...emptyChatState(), storedSessionId: 'scheduled-1' })
    const connection = { request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { version: 'current' } }) }
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'scheduled-1' },
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/scheduled-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ role: 'user', content: marker, row_id: 1 }]
      }))
      .handle('session.list', () => ({
        sessions: [{ id: 'scheduled-1', message_count: 1, preview: marker, source: 'cron', started_at: 1, title: 'Job' }]
      }))
    const controller = new GatewayController(connection as never, gateway)

    await controller.connect()

    expect($chat.get().transcript.context.source).toBe('cron')
    expect($chat.get().transcript.entries[0].kind).toBe('cron-instructions')
    controller.dispose()
  })

  it('clears non-prefix provenance when refresh omits the active session', async () => {
    $chat.set({
      ...emptyChatState(),
      runtimeSessionId: 'runtime-1',
      storedSessionId: 'scheduled-1',
      transcript: createTranscript({ source: 'cron', storedSessionId: 'scheduled-1' }, [
        { role: 'user', content: marker, row_id: 1 }
      ])
    })
    const gateway = new MemoryGateway().handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController({} as never, gateway)

    await controller.refreshSessions()

    expect($chat.get().transcript.context.source).toBeNull()
    expect($chat.get().transcript.entries[0].kind).toBe('message')
    controller.dispose()
  })

  it('uses the cron id rule before the session list is populated', async () => {
    const gateway = new MemoryGateway()
      .handle('session.resume', () => ({
        info: { desktop_contract: MINIMUM_CONTRACT, stored_session_id: 'cron_job-1' },
        messages: [{ role: 'user', content: marker, row_id: 1 }],
        session_id: 'runtime-1'
      }))
      .handle('/api/sessions/cron_job-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => ({
        messages: [{ role: 'user', content: marker, row_id: 1 }]
      }))
    const controller = new GatewayController({} as never, gateway)

    await controller.resumeSession('cron_job-1')

    expect($chat.get().transcript.context.source).toBeNull()
    expect($chat.get().transcript.entries[0].kind).toBe('cron-instructions')
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
    await expect(controller.newSession()).rejects.toMatchObject({ code: 'GATEWAY_UNAVAILABLE' })
    $connection.set({ ...$connection.get(), phase: 'connected' })
    await expect(controller.newSession()).resolves.toMatchObject({ session: { runtimeSessionId: 'runtime-current' } })
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

  it('does not connect while a browser OAuth redirect is leaving the page', async () => {
    const login = vi.fn().mockResolvedValue(null)
    const connect = vi.spyOn(GatewayController.prototype, 'connect').mockResolvedValue()
    const controller = new GatewayController({ login } as never)
    await controller.login('browser-provider')
    expect(connect).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('reports incomplete remote sign out without reconnecting on foreground', async () => {
    const logout = vi.fn().mockRejectedValue(new TypeError('offline'))
    const controller = new GatewayController({ logout } as never)
    await controller.initialize()
    await expect(controller.logout()).rejects.toThrow('offline')
    const lifecycleHandler = capacitorApp.addListener.mock.calls[0]?.[1] as ((state: { isActive: boolean }) => void)
    lifecycleHandler({ isActive: true })
    expect($connection.get()).toMatchObject({ phase: 'disconnected', error: expect.stringContaining('could not be confirmed') })
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

describe('roster tap into a desktop conversation', () => {
  it("resumes the profile's existing desktop conversation instead of starting fresh", async () => {
    const desktopSession = {
      id: 'codex-desktop-1', message_count: 2, preview: 'Hey, tell me about yourself!',
      source: 'desktop', started_at: 300, title: 'Hey, tell me about yourself!'
    }
    const gateway = new ConnectionAwareGateway()
      .handle('session.list', params =>
        // The real gateway keeps bot-mode sessions hidden from global lists
        // and only returns them to callers that own them (include_hidden).
        (params as { profile?: string; include_hidden?: boolean }).profile === 'codex' && (params as { include_hidden?: boolean }).include_hidden
          ? { sessions: [desktopSession] }
          : { sessions: [] })
      .handle('session.create', () => ({
        session_id: 'fresh-runtime', stored_session_id: 'fresh-stored',
        info: { desktop_contract: 6, model: 'fixture/test-model', title: '' }
      }))
      .handle('session.resume', params => ({
        session_id: 'resumed-runtime', stored_session_id: (params as { session_id: string }).session_id,
        info: { desktop_contract: 6, model: 'fixture/test-model', title: desktopSession.title }
      }))
      .handle('/api/sessions/codex-desktop-1/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=codex', () => ({
        messages: [{ kind: 'user', session_id: 'codex-desktop-1', text: 'Hey, tell me about yourself!' }],
        pagination: { limit: 80, offset: 0, returned: 1 }
      }))
    const controller = new GatewayController(
      { request: identityRequest(), probe: vi.fn().mockResolvedValue({ authMode: 'token', status: null }) } as never,
      gateway
    )

    await controller.openProfile('codex')

    const resumedIds = gateway.calls
      .filter(call => call.kind === 'rpc' && call.method === 'session.resume')
      .map(call => (call.value as { session_id: string }).session_id)
    expect(resumedIds).toContain('codex-desktop-1')
    expect($chat.get().storedSessionId).toBe('codex-desktop-1')
    controller.dispose()
  })
})


describe('local privacy cleanup', () => {
  it('clears every owner profile without logout, route reset, remote deletion, or automatic restore', async () => {
    const gateway = new ConnectionAwareGateway().handle('session.create', () => sessionReply('new')).handle('session.list', () => ({ sessions: [] }))
    const logout = vi.fn()
    const controller = new GatewayController({ logout, probe: vi.fn().mockResolvedValue({ authMode: 'token', status: null }), request: identityRequest() } as never, gateway)
    await controller.connect()
    const owner = $draftOwner.get()
    const bookmarkKeys = [null, 'work'].map(profile => sessionBookmarkKey({ connectionKey: owner.gateway, profile }))
    for (const profile of [null, 'work']) {
      const draft = chatDrafts.select({ owner, profile, conversation: 'private', provisional: false })
      chatDrafts.write(draft.key, { ...emptyDraft(), text: 'unfinished' })
      transcriptCache.write({ owner, profile, storedSessionId: 'private' }, { title: 'Private', source: null, startedAt: null, lastSyncedAt: 1, entries: [] })
    }
    bookmarkKeys.forEach(key => localStorage.setItem(key, 'private'))
    localStorage.setItem('hermes.theme', 'dark')
    localStorage.setItem('unrelated', 'keep')
    const before = gateway.calls.length
    const result = controller.clearLocalData(draftOwnerKey(owner))
    expect(result).toEqual({ complete: true, failures: [] })
    expect(gateway.connected).toBe(true)
    expect(logout).not.toHaveBeenCalled()
    expect(gateway.calls.slice(before).filter(call => call.kind === 'rpc' || call.kind === 'request')).toEqual([])
    expect($draftOwner.get()).toMatchObject({ principal: owner.principal, locked: false, generation: owner.generation + 1 })
    expect($chat.get()).toMatchObject({ runtimeSessionId: null, storedSessionId: null })
    expect(chatDrafts.list()).toEqual([])
    expect(transcriptCache.list($draftOwner.get())).toEqual([])
    bookmarkKeys.forEach(key => expect(localStorage.getItem(key)).toBeNull())
    expect(localStorage.getItem('hermes.theme')).toBe('dark')
    expect(localStorage.getItem('unrelated')).toBe('keep')
    await controller.retryConnection()
    expect($chat.get().storedSessionId).toBeNull()
    controller.dispose()
  })

  it('rejects a confirmation captured for another owner and blocks active work', () => {
    const controller = new GatewayController({} as never, new MemoryGateway())
    expect(controller.clearLocalData('other').complete).toBe(false)
    $chat.set({ ...emptyChatState(), running: true })
    expect(controller.privacyClearBlocker()).toMatch(/Finish the active/)
    expect(controller.clearLocalData(draftOwnerKey($draftOwner.get())).complete).toBe(false)
    controller.dispose()
  })

  it('retains other accounts and reports failed removals while attempting every category', () => {
    const owner = $draftOwner.get()
    const draft = chatDrafts.select({ owner, profile: null, conversation: 'a', provisional: false })
    chatDrafts.write(draft.key, { ...emptyDraft(), text: 'private' })
    const otherKey = 'hermes.drafts.v1:' + encodeURIComponent(JSON.stringify(['other-owner', null, 'a']))
    localStorage.setItem(otherKey, 'other private data')
    const bookmark = sessionBookmarkKey(); localStorage.setItem(bookmark, 'a')
    const remove = Storage.prototype.removeItem
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) { if (key === draft.key) throw new Error('Denied'); remove.call(this, key) })
    const controller = new GatewayController({} as never, new MemoryGateway())
    expect(controller.clearLocalData(draftOwnerKey(owner))).toMatchObject({ complete: false, failures: ['Draft and recovery removal could not be confirmed.'] })
    expect(localStorage.getItem(bookmark)).toBeNull()
    expect(localStorage.getItem(otherKey)).toBe('other private data')
    controller.dispose()
  })

  it('retires deferred history and handles another tab’s reset without locking the account', async () => {
    const history = deferred<{ messages: [] }>()
    const gateway = new MemoryGateway().handle('session.create', () => sessionReply('a')).handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController({ probe: vi.fn().mockResolvedValue({ authMode: 'token', status: null }), request: identityRequest() } as never, gateway)
    await controller.connect()
    gateway.handle('/api/sessions/a/messages?include_compacted=true&limit=80&offset=0&order=latest&profile=default', () => history.promise)
    const pending = controller.conversation.reconcileHistory()
    localPrivacy.beginReset(draftOwnerKey($draftOwner.get()))
    history.resolve({ messages: [] })
    await pending.catch(() => undefined)
    expect($draftOwner.get().locked).toBe(false)
    expect($chat.get().storedSessionId).toBeNull()
    expect(Object.keys(localStorage).filter(key => key.startsWith('hermes.transcript.v2:') || key.startsWith('hermes.mobile.session.v2:'))).toEqual([])
    controller.dispose()
  })
})

describe('draft account lifecycle', () => {
  it('locks a warm verified token workspace when account verification expires', async () => {
    const connection = { probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { auth_required: false } }), request: vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { status: 401 })) }
    const gateway = new MemoryGateway()
    const controller = new GatewayController(connection as never, gateway)
    await expect(controller.connect()).rejects.toThrow('expired')
    expect($draftOwner.get().locked).toBe(true)
    expect($connection.get()).toMatchObject({ errorKind: 'auth', workspaceAvailable: false })
    expect(gateway.calls.some(call => call.kind === 'connect' || call.method === 'session.create')).toBe(false)
    controller.dispose()
  })

  it('clears the old private view before publishing a changed verified owner', async () => {
    $chat.set({ ...emptyChatState(), storedSessionId: 'private-a', transcript: createTranscript({ source: null, storedSessionId: 'private-a' }, [{ row_id: 1, role: 'user', content: 'Private account A' }]) })
    const observed: string[][] = []
    const stop = $draftOwner.listen(owner => { if (owner.principal === JSON.stringify(['test', 'other'])) observed.push($chat.get().transcript.entries.map(entry => entry.content)) })
    const connection = { probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { auth_required: false } }), request: vi.fn().mockResolvedValue({ body: { org_id: 'test', user_id: 'other' } }) }
    const gateway = new MemoryGateway().handle('session.create', () => sessionReply('new')).handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController(connection as never, gateway)
    try {
      await controller.connect()
      expect(observed).toEqual([[]])
      expect($chat.get().storedSessionId).toBe('new')
    } finally { stop(); controller.dispose() }
  })
  it('clears local drafts even when remote logout rejects', async () => {
    const { key } = chatDrafts.select({ owner: $draftOwner.get(), profile: null, conversation: 'private', provisional: false })
    chatDrafts.write(key, { ...emptyDraft(), text: 'private draft' })
    const bookmarks = [null, 'work'].map(profile => sessionBookmarkKey({ connectionKey: $draftOwner.get().gateway, profile }))
    bookmarks.forEach(key => localStorage.setItem(key, 'private'))
    const controller = new GatewayController({ logout: vi.fn().mockRejectedValue(new Error('offline')) } as never, new MemoryGateway())
    await expect(controller.logout()).rejects.toThrow('offline')
    bookmarks.forEach(key => expect(localStorage.getItem(key)).toBeNull())
    expect(localStorage.getItem(key)).toBeNull()
    expect(chatDrafts.list()).toEqual([])
    expect($draftOwner.get().locked).toBe(true)
    controller.dispose()
  })

  it('keeps token gateways without account identity memory-only', async () => {
    const connection = { probe: vi.fn().mockResolvedValue({ authMode: 'token', status: { auth_required: false } }), request: vi.fn().mockRejectedValue(Object.assign(new Error('unsupported'), { status: 404 })) }
    const gateway = new MemoryGateway().handle('session.create', () => sessionReply('new'))
      .handle('session.list', () => ({ sessions: [] }))
    const controller = new GatewayController(connection as never, gateway)
    await controller.connect()
    expect($draftOwner.get().principal).toBeNull()
    expect($connection.get().phase).toBe('connected')
    controller.dispose()
  })
})
