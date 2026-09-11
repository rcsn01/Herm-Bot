import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HermesConnectionWeb, usesBrowserGatewayProxy } from './hermes-connection'

const fetchMock = vi.fn<typeof fetch>()
const origin = window.location.origin
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('browser gateway connection', () => {
  it('uses the same-origin proxy for this app origin', () => {
    expect(usesBrowserGatewayProxy(origin)).toBe(true)
    expect(usesBrowserGatewayProxy('https://hermes.example')).toBe(false)
  })
  it('uses the same origin without requiring an initial configure call', async () => {
    fetchMock.mockResolvedValue(json({ auth_required: true }))
    const connection = new HermesConnectionWeb()
    await expect(connection.probe()).resolves.toMatchObject({ authMode: 'interactive' })
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/status`, expect.objectContaining({ credentials: 'include', redirect: 'error' }))
  })

  it('rejects a direct browser gateway URL instead of forwarding its token', async () => {
    const connection = new HermesConnectionWeb()
    await expect(connection.configure({ remoteURL: 'http://h-lap02.tail3ce9b9.ts.net:9119', token: 'test-token' }))
      .rejects.toThrow('Docker proxy')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('hermes.token')).toBeNull()

    fetchMock.mockImplementation(async () => json({ ok: true }))
    await connection.configure({ remoteURL: origin, token: ' test-token ' })
    await connection.request({ path: '/api/config', profile: 'client work' })
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/config?profile=client+work`, expect.objectContaining({
      headers: { 'X-Hermes-Session-Token': 'test-token' }, redirect: 'error'
    }))
    expect(sessionStorage.getItem('hermes.token')).toBe('test-token')
    expect(localStorage.getItem('hermes.token')).toBeNull()
  })

  it.each(['//other.example/api/status', 'https://other.example/api/status', '/\\other.example/api/status'])(
    'rejects a request that could leave this origin: %s', async path => {
      const connection = new HermesConnectionWeb()
      await expect(connection.request({ path })).rejects.toThrow('same-origin')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('discards a stored direct gateway URL instead of bypassing the browser proxy', async () => {
    localStorage.setItem('hermes.remoteURL', 'http://h-lap02.tail3ce9b9.ts.net:9119')
    sessionStorage.setItem('hermes.token', 'saved-token')
    fetchMock.mockResolvedValue(json({ auth_required: true }))
    const connection = new HermesConnectionWeb()
    await connection.probe()
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/status`, expect.objectContaining({
      credentials: 'include',
      headers: {}
    }))
    expect(localStorage.getItem('hermes.remoteURL')).toBeNull()
    expect(sessionStorage.getItem('hermes.token')).toBeNull()
  })

  it('opens a WebSocket through the same-origin proxy', async () => {
    const connection = new HermesConnectionWeb()
    await connection.configure({ remoteURL: origin, token: 'ws-token' })
    const url = new URL((await connection.getWebSocketURL({ profile: 'work' })).url)
    expect(url.origin).toBe(origin.replace(/^http/, 'ws'))
    expect(url.pathname).toBe('/api/ws')
    expect(url.searchParams.get('token')).toBe('ws-token')
    expect(url.searchParams.get('profile')).toBe('work')
  })

  it('restores a same-origin token when the browser session reloads', async () => {
    await new HermesConnectionWeb().configure({ remoteURL: origin, token: 'session-token' })
    const restored = new HermesConnectionWeb()
    fetchMock.mockResolvedValue(json({ auth_required: false }))
    await restored.probe()
    const url = new URL((await restored.getWebSocketURL({ profile: 'work' })).url)
    expect(url.origin).toBe(origin.replace(/^http/, 'ws'))
    expect(url.searchParams.get('token')).toBe('session-token')
    expect(url.searchParams.get('profile')).toBe('work')
  })

  it('obtains a fresh cookie-authenticated ticket for each WebSocket connection', async () => {
    fetchMock.mockResolvedValueOnce(json({ auth_required: true }))
      .mockResolvedValueOnce(json({ ticket: 'first' }))
      .mockResolvedValueOnce(json({ ticket: 'second' }))
    const connection = new HermesConnectionWeb()
    await connection.probe()
    const first = new URL((await connection.getWebSocketURL({ profile: 'work' })).url)
    const second = new URL((await connection.getWebSocketURL()).url)
    expect(first.searchParams.get('ticket')).toBe('first')
    expect(first.searchParams.get('profile')).toBe('work')
    expect(second.searchParams.get('ticket')).toBe('second')
    expect(second.searchParams.get('profile')).toBe('default')
    expect(second.searchParams.has('token')).toBe(false)
    expect(fetchMock).toHaveBeenLastCalledWith(`${origin}/api/auth/ws-ticket`, expect.objectContaining({ method: 'POST', credentials: 'include' }))
  })

  it('navigates OAuth through the gateway and returns to the session link', async () => {
    window.history.replaceState(null, '', '/session/a%2Fb?profile=work')
    const navigate = vi.fn()
    const connection = new HermesConnectionWeb(navigate)
    await expect(connection.login({ provider: 'test provider' })).resolves.toBeNull()
    const url = new URL(navigate.mock.calls[0][0])
    expect(url.origin).toBe(origin)
    expect(url.pathname).toBe('/auth/login')
    expect(url.searchParams.get('provider')).toBe('test provider')
    expect(url.searchParams.get('next')).toBe('/session/a%2Fb?profile=work')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signs in with browser cookies without persisting the password', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true })).mockResolvedValueOnce(json({ user_id: 'user' }))
    const connection = new HermesConnectionWeb()
    await expect(connection.passwordLogin({ provider: 'password', username: 'user', password: 'secret' })).resolves.toEqual({ user_id: 'user' })
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${origin}/auth/password-login`, expect.objectContaining({ method: 'POST', credentials: 'include' }))
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears tokens on logout without following the login redirect', async () => {
    const connection = new HermesConnectionWeb()
    await connection.configure({ remoteURL: origin, token: 'token' })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302 })).mockResolvedValueOnce(json({}))
    await connection.logout()
    expect(sessionStorage.getItem('hermes.token')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/auth/logout`, expect.objectContaining({ method: 'POST', redirect: 'manual', credentials: 'include' }))
    await connection.request({ path: '/api/status' })
    expect(fetchMock).toHaveBeenLastCalledWith(`${origin}/api/status`, expect.objectContaining({ headers: {} }))
  })

  it('clears the local token even when gateway logout is unreachable', async () => {
    const connection = new HermesConnectionWeb()
    await connection.configure({ remoteURL: origin, token: 'token' })
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await expect(connection.logout()).rejects.toThrow('offline')
    expect(sessionStorage.getItem('hermes.token')).toBeNull()
  })

  it('reports proxy HTML errors without exposing their body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>private diagnostic</html>', { status: 502 }))
    const connection = new HermesConnectionWeb()
    await expect(connection.request({ path: '/api/status' })).rejects.toMatchObject({ status: 502, message: 'Hermes returned HTTP 502' })
    fetchMock.mockResolvedValueOnce(new Response('<html>Cloudflare login</html>'))
    await expect(connection.probe()).rejects.toThrow('Reload to sign in')
  })

  it('cancels a streaming download as soon as the byte limit is exceeded', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(12)) }, cancel
    })))
    const connection = new HermesConnectionWeb()
    await expect(connection.download({ path: '/api/files/download', maxBytes: 10 })).rejects.toThrow('allowed size')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('propagates request cancellation to fetch', async () => {
    const abort = new AbortController()
    abort.abort()
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options?.signal?.aborted).toBe(true)
      throw options?.signal?.reason
    })
    await expect(new HermesConnectionWeb().request({ path: '/api/status', signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
