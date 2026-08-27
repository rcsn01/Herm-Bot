import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayController, isReauthenticationError, MINIMUM_CONTRACT, toTranscript } from '~/state/gateway-controller'
import { $chat, $preferences, $sessions } from '~/state/store'
import { emptyChatState } from '~/state/event-reducer'

beforeEach(() => {
  $chat.set(emptyChatState())
  $sessions.set([])
  $preferences.set({ authMode: 'token', profile: null, remoteURL: '', theme: 'system' })
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
    const request = vi.fn().mockResolvedValue({})
    const controller = new GatewayController({ request } as never)
    vi.spyOn(controller.client, 'request').mockResolvedValue({ sessions: [] })

    await controller.renameSession('session/1', 'Renamed')
    await controller.archiveSession('session/1')
    await controller.deleteSession('session/1')

    expect(request.mock.calls).toEqual([
      [{
        body: { profile: 'client work/ios', title: 'Renamed' },
        method: 'PATCH',
        path: '/api/sessions/session%2F1'
      }],
      [{
        body: { archived: true, profile: 'client work/ios' },
        method: 'PATCH',
        path: '/api/sessions/session%2F1'
      }],
      [{ method: 'DELETE', path: '/api/sessions/session%2F1?profile=client%20work%2Fios' }]
    ])
    controller.dispose()
  })

  it('omits profile addressing for the default profile', async () => {
    const request = vi.fn().mockResolvedValue({})
    const controller = new GatewayController({ request } as never)
    vi.spyOn(controller.client, 'request').mockResolvedValue({ sessions: [] })

    await controller.renameSession('session-1', 'Renamed')
    await controller.deleteSession('session-1')

    expect(request.mock.calls).toEqual([
      [{ body: { title: 'Renamed' }, method: 'PATCH', path: '/api/sessions/session-1' }],
      [{ method: 'DELETE', path: '/api/sessions/session-1' }]
    ])
    controller.dispose()
  })
})

describe('prompt submission safety', () => {
  it('submits ordinary prompts without truncation parameters', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const controller = new GatewayController({} as never)
    const request = vi.spyOn(controller.client, 'request').mockResolvedValue({})

    await controller.send('  hello  ')

    expect(request).toHaveBeenCalledWith(
      'prompt.submit',
      { session_id: 'runtime-1', text: 'hello' },
      1_800_000
    )
    controller.dispose()
  })

  it('queues active-turn prompts at the gateway instead of client memory', async () => {
    $chat.set({ ...emptyChatState(), running: true, runtimeSessionId: 'runtime-1' })
    const controller = new GatewayController({} as never)
    const request = vi.spyOn(controller.client, 'request').mockResolvedValue({})

    await controller.send('next task')

    expect(request).toHaveBeenCalledWith('prompt.submit', {
      queued: true,
      session_id: 'runtime-1',
      text: 'next task'
    }, 1_800_000)
    controller.dispose()
  })

  it('confirms a durable first-turn rewind by both ordinal and row id', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const controller = new GatewayController({} as never)
    const request = vi.spyOn(controller.client, 'request').mockResolvedValue({})

    await controller.retryFrom(0, 41, 'edited hello')

    expect(request).toHaveBeenCalledWith('prompt.submit', {
      confirm_empty_truncate: true,
      confirm_truncate: true,
      session_id: 'runtime-1',
      text: 'edited hello',
      truncate_before_row_id: 41,
      truncate_before_user_ordinal: 0
    }, 1_800_000)
    controller.dispose()
  })

  it('refuses to rewind without a durable row id', async () => {
    $chat.set({ ...emptyChatState(), runtimeSessionId: 'runtime-1' })
    const controller = new GatewayController({} as never)
    const request = vi.spyOn(controller.client, 'request').mockResolvedValue({})

    await expect(controller.retryFrom(1, undefined as never, 'unsafe')).rejects.toThrow(/durable message row/i)
    expect(request).not.toHaveBeenCalled()
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

describe('backend compatibility', () => {
  it('rejects an older contract and accepts the minimum supported contract', async () => {
    const controller = new GatewayController({} as never)
    vi.spyOn(controller.client, 'request')
      .mockResolvedValueOnce({ info: { desktop_contract: MINIMUM_CONTRACT - 1 }, session_id: 'runtime-old' })
      .mockResolvedValueOnce({ info: { desktop_contract: MINIMUM_CONTRACT }, session_id: 'runtime-current' })

    await expect(controller.newSession()).rejects.toThrow(/too old/i)
    expect($chat.get().runtimeSessionId).toBeNull()

    await expect(controller.newSession()).resolves.toBeUndefined()
    expect($chat.get()).toMatchObject({ contractVersion: MINIMUM_CONTRACT, runtimeSessionId: 'runtime-current' })
    controller.dispose()
  })

  it('fails closed when the gateway contract is malformed', async () => {
    const controller = new GatewayController({} as never)
    vi.spyOn(controller.client, 'request').mockResolvedValue({
      info: { desktop_contract: 'unknown' },
      session_id: 'runtime-unknown'
    })

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
