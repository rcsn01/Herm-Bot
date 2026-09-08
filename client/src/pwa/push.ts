import { atom } from 'nanostores'

export interface WebPushState {
  busy: boolean
  enabled: boolean
  error: string | null
  permission: NotificationPermission | 'unsupported'
  relayAvailable: boolean | null
}

const initialState = (): WebPushState => ({
  busy: false,
  enabled: false,
  error: null,
  permission: supportsWebPush() ? Notification.permission : 'unsupported',
  relayAvailable: null
})

export const $webPush = atom<WebPushState>(initialState())

function supportsWebPush(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
}

function authHeaders(): HeadersInit {
  const token = sessionStorage.getItem('hermes.token')
  return token ? { 'X-Hermes-Session-Token': token } : {}
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0))
  return new Uint8Array(bytes.buffer)
}

async function relayRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`/push/v1/${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...authHeaders(),
      ...init.headers
    },
    redirect: 'error'
  })
  if (!response.ok) throw new Error(response.status === 404
    ? 'Web Push is not enabled on this Hermes Mobile server.'
    : `Web Push request failed (HTTP ${response.status}).`)
  return response
}

function patchState(patch: Partial<WebPushState>) {
  $webPush.set({ ...$webPush.get(), ...patch })
}

export async function refreshWebPushState(): Promise<void> {
  if (!supportsWebPush()) {
    $webPush.set(initialState())
    return
  }
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    const response = await relayRequest('public-key')
    const payload = await response.json() as { publicKey?: string }
    if (!payload.publicKey) throw new Error('The Web Push server did not provide a public key.')
    patchState({
      enabled: subscription !== null,
      error: null,
      permission: Notification.permission,
      relayAvailable: true
    })
  } catch (error) {
    patchState({
      enabled: false,
      error: error instanceof Error ? error.message : 'Web Push status could not be loaded.',
      permission: Notification.permission,
      relayAvailable: false
    })
  }
}

export async function enableWebPush(): Promise<void> {
  if (!supportsWebPush()) {
    patchState({ error: 'Web Push is unavailable in this browser.', permission: 'unsupported' })
    return
  }
  patchState({ busy: true, error: null })
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') throw new Error('Notification permission was not granted.')
    const keyResponse = await relayRequest('public-key')
    const { publicKey } = await keyResponse.json() as { publicKey?: string }
    if (!publicKey) throw new Error('The Web Push server did not provide a public key.')
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    const subscription = existing ?? await registration.pushManager.subscribe({
      applicationServerKey: applicationServerKey(publicKey),
      userVisibleOnly: true
    })
    try {
      await relayRequest('subscriptions', {
        body: JSON.stringify(subscription),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT'
      })
    } catch (error) {
      if (!existing) await subscription.unsubscribe().catch(() => false)
      throw error
    }
    patchState({ enabled: true, permission, relayAvailable: true })
  } catch (error) {
    patchState({ error: error instanceof Error ? error.message : 'Web Push could not be enabled.' })
  } finally {
    patchState({ busy: false })
  }
}

export async function disableWebPush(): Promise<void> {
  if (!supportsWebPush()) return
  patchState({ busy: true, error: null })
  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      await relayRequest('subscriptions', {
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        headers: { 'Content-Type': 'application/json' },
        method: 'DELETE'
      })
      await subscription.unsubscribe()
    }
    patchState({ enabled: false, relayAvailable: true })
  } catch (error) {
    patchState({ error: error instanceof Error ? error.message : 'Web Push could not be disabled.' })
  } finally {
    patchState({ busy: false })
  }
}
