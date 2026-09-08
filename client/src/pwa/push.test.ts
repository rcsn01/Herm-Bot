import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $webPush, disableWebPush, enableWebPush, refreshWebPushState } from './push'

const subscription = {
  endpoint: 'https://push.example/subscription/1',
  toJSON: () => ({
    endpoint: 'https://push.example/subscription/1',
    keys: { auth: 'auth-key', p256dh: 'public-key' }
  }),
  unsubscribe: vi.fn(async () => true)
}
const getSubscription = vi.fn<() => Promise<typeof subscription | null>>()
const subscribe = vi.fn(async () => subscription)

describe('PWA Web Push subscription', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission: vi.fn(async () => 'granted') }
    })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class PushManager {} })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) }
    })
    getSubscription.mockReset().mockResolvedValue(null)
    subscribe.mockClear()
    subscription.unsubscribe.mockClear()
    sessionStorage.clear()
    $webPush.set({ busy: false, enabled: false, error: null, permission: 'default', relayAvailable: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('subscribes with the relay key and authenticates registration', async () => {
    sessionStorage.setItem('hermes.token', 'session-token')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ publicKey: 'AQID' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await enableWebPush()

    expect(subscribe).toHaveBeenCalledWith({
      applicationServerKey: new Uint8Array([1, 2, 3]),
      userVisibleOnly: true
    })
    expect(fetchMock).toHaveBeenLastCalledWith('/push/v1/subscriptions', expect.objectContaining({
      headers: expect.objectContaining({ 'X-Hermes-Session-Token': 'session-token' }),
      method: 'PUT'
    }))
    expect($webPush.get()).toMatchObject({ busy: false, enabled: true, relayAvailable: true })
  })

  it('removes the relay registration before unsubscribing locally', async () => {
    getSubscription.mockResolvedValue(subscription)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))

    await disableWebPush()

    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect($webPush.get().enabled).toBe(false)
  })

  it('reports an unavailable relay without claiming notifications are enabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))

    await refreshWebPushState()

    expect($webPush.get()).toMatchObject({
      enabled: false,
      error: expect.stringContaining('not enabled'),
      relayAvailable: false
    })
  })
})
