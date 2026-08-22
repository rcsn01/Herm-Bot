import { afterEach, describe, expect, it, vi } from 'vitest'

import { GatewayController, isReauthenticationError, toTranscript } from '~/state/gateway-controller'

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
