import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { $draftOwner } from '~/state/draft-owner'
import { $webPush, disableWebPush, enableWebPush, refreshWebPushState, sendTestNotification, verifyNotificationOwner } from './push'
const owner = 'a'.repeat(64)
const key = btoa(String.fromCharCode(4, ...Array(64).fill(0)))
const subscription = { endpoint: 'https://fcm.googleapis.com/device', expirationTime: null, toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/device', keys: { auth: 'auth', p256dh: 'key' } }), unsubscribe: vi.fn(async () => true) }
const getSubscription = vi.fn<() => Promise<typeof subscription | null>>()
const subscribe = vi.fn(async () => subscription)
let registered: boolean
let calls: Array<{ path: string; init?: RequestInit }>
let fetchMock: ReturnType<typeof vi.fn>
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }) }
describe('account-bound notification setup', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'default', requestPermission: vi.fn(async () => { Object.assign(Notification, { permission: 'granted' }); return 'granted' }) } })
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} })
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription, subscribe } }) } })
    getSubscription.mockReset().mockResolvedValue(null)
    subscribe.mockReset().mockImplementation(async () => { getSubscription.mockResolvedValue(subscription); return subscription })
    subscription.unsubscribe.mockReset().mockImplementation(async () => { getSubscription.mockResolvedValue(null); return true })
    sessionStorage.clear()
    $draftOwner.set({ gateway: '/', principal: 'account-a', generation: $draftOwner.get().generation + 1, locked: false })
    registered = false
    calls = []
    fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      if (path.endsWith('public-key')) return response({ publicKey: key, version: 2 })
      if (path.endsWith('status')) return response({ version: 2, owner, registered, binding: registered ? 'binding-1' : null })
      if (path.endsWith('subscriptions')) { registered = init?.method === 'PUT'; return response({ ok: true, removed: 1 }) }
      return response({ outcome: 'accepted' })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('requests permission from the gesture, registers and verifies separately', async () => {
    sessionStorage.setItem('hermes.token', 'session-token')
    await enableWebPush()
    expect(Notification.requestPermission).toHaveBeenCalledOnce()
    expect(subscribe).toHaveBeenCalledOnce()
    expect(calls.find(call => call.init?.method === 'PUT')?.init?.headers).toMatchObject({ 'X-Hermes-Session-Token': 'session-token' })
    expect($webPush.get()).toMatchObject({ local: 'present', registration: 'confirmed', enabled: true, busy: false })
  })
  it('does not equate a local subscription with server registration', async () => {
    getSubscription.mockResolvedValue(subscription)
    await refreshWebPushState()
    expect($webPush.get()).toMatchObject({ local: 'present', registration: 'missing', enabled: false })
    expect(Notification.requestPermission).not.toHaveBeenCalled()
  })
  it('keeps local evidence when the relay is unavailable', async () => {
    getSubscription.mockResolvedValue(subscription)
    fetchMock.mockResolvedValue(response({}, 404))
    await refreshWebPushState()
    expect($webPush.get()).toMatchObject({ local: 'present', registration: 'unknown', enabled: false, error: expect.stringContaining('update') })
  })
  it('does not create a subscription without verified identity', async () => {
    fetchMock.mockImplementation(async (path: string) => path.endsWith('public-key') ? response({ publicKey: key, version: 2 }) : response({}, 503))
    await enableWebPush()
    expect(subscribe).not.toHaveBeenCalled()
    expect($webPush.get().error).toContain('identity')
  })
  it('handles denied and dismissed prompts without registering', async () => {
    vi.mocked(Notification.requestPermission).mockResolvedValueOnce('denied')
    await enableWebPush()
    expect($webPush.get().permission).toBe('denied')
    expect(subscribe).not.toHaveBeenCalled()
    vi.mocked(Notification.requestPermission).mockResolvedValueOnce('default')
    await enableWebPush()
    expect($webPush.get().permission).toBe('default')
  })
  it('removes only the captured server binding before local unsubscribe', async () => {
    registered = true
    getSubscription.mockResolvedValue(subscription)
    await disableWebPush()
    expect(JSON.parse(calls.find(call => call.init?.method === 'DELETE')!.init!.body as string)).toEqual({ endpoint: subscription.endpoint, binding: 'binding-1' })
    expect($webPush.get()).toMatchObject({ local: 'missing', registration: 'missing' })
  })
  it('does not unsubscribe when its captured registration was replaced', async () => {
    registered = true
    getSubscription.mockResolvedValue(subscription)
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => path.endsWith('status') ? response({ version: 2, owner, registered: true, binding: 'binding-1' }) : response({ removed: 0 }))
    await disableWebPush()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect($webPush.get().error).toContain('Registration changed')
  })
  it('can stop local delivery while reporting unverified remote cleanup', async () => {
    getSubscription.mockResolvedValue(subscription)
    fetchMock.mockResolvedValue(response({}, 503))
    await disableWebPush()
    expect(subscription.unsubscribe).toHaveBeenCalledOnce()
    expect($webPush.get()).toMatchObject({ local: 'missing', registration: 'unknown', error: expect.stringContaining('Remote cleanup') })
  })
  it('submits a fixed-target test and reports acceptance rather than delivery', async () => {
    registered = true
    Object.assign(Notification, { permission: 'granted' })
    getSubscription.mockResolvedValue(subscription)
    await sendTestNotification()
    const body = JSON.parse(calls.find(call => call.path.endsWith('/test'))!.init!.body as string)
    expect(Object.keys(body).sort()).toEqual(['binding', 'requestId'])
    expect($webPush.get().test).toBe('accepted')
    await sendTestNotification()
    expect(calls.filter(call => call.path.endsWith('/test'))).toHaveLength(1)
  })
  it('a terminal unknown provider result allows a new explicit test after cooldown', async () => {
    vi.useFakeTimers()
    registered = true
    Object.assign(Notification, { permission: 'granted' })
    getSubscription.mockResolvedValue(subscription)
    const ids: string[] = []
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith('status')) return response({ version: 2, owner, registered: true, binding: 'binding-1' })
      ids.push(JSON.parse(init!.body as string).requestId)
      return response({ outcome: 'unknown' })
    })
    await sendTestNotification()
    await vi.advanceTimersByTimeAsync(30001)
    await sendTestNotification()
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })
  it('does not send a test for an unregistered device', async () => {
    getSubscription.mockResolvedValue(subscription)
    await sendTestNotification()
    expect(calls.some(call => call.path.endsWith('/test'))).toBe(false)
  })
  it('retires pending responses after account changes', async () => {
    let finish!: (value: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve }))
    const work = refreshWebPushState()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    $draftOwner.set({ ...$draftOwner.get(), principal: 'account-b', generation: $draftOwner.get().generation + 1 })
    finish(response({ version: 2, owner, registered: true, binding: 'a' }))
    await work
    expect($webPush.get()).toMatchObject({ owner: null, registration: 'unknown', busy: false })
  })
  it('bounds service worker readiness', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } })
    const work = refreshWebPushState()
    await vi.advanceTimersByTimeAsync(10001)
    await work
    expect($webPush.get()).toMatchObject({ busy: false, error: expect.stringContaining('Service worker') })
  })
  it('verifies notification owner against the authenticated relay, not the URL alone', async () => {
    expect(await verifyNotificationOwner(owner)).toBe(true)
    expect(await verifyNotificationOwner('b'.repeat(64))).toBe(false)
    fetchMock.mockResolvedValue(response({}, 401))
    expect(await verifyNotificationOwner(owner)).toBe(false)
  })
})
