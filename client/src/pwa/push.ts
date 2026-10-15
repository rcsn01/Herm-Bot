import { atom } from 'nanostores'
import { Capacitor } from '@capacitor/core'
import { $draftOwner, draftOwnerKey } from '~/state/draft-owner'
import { localPrivacy } from '~/state/local-privacy'

export type PushFact = 'unknown' | 'checking' | 'missing' | 'present' | 'expired' | 'incompatible'
export interface WebPushState {
  busy: boolean
  enabled: boolean
  error: string | null
  permission: NotificationPermission | 'unsupported'
  relayAvailable: boolean | null
  local: PushFact
  registration: 'unknown' | 'checking' | 'missing' | 'confirmed'
  owner: string | null
  binding: string | null
  test: 'idle' | 'sending' | 'accepted' | 'expired' | 'unknown'
  retryAt: number
}

export function webPushEnvironment(): 'native' | 'insecure' | 'install-ios' | 'unsupported' | 'supported' {
  if (Capacitor.isNativePlatform()) return 'native'
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure'
  if ('Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window) return 'supported'
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone
  return ios && !standalone ? 'install-ios' : 'unsupported'
}
const initialState = (): WebPushState => ({ busy: false, enabled: false, error: null,
  permission: webPushEnvironment() === 'supported' ? Notification.permission : 'unsupported',
  relayAvailable: null, local: 'unknown', registration: 'unknown', owner: null, binding: null, test: 'idle', retryAt: 0 })
export const $webPush = atom<WebPushState>(initialState())
let generation = 0
let expiredEndpoint: string | null = null
let attempt: { scope: string; binding: string; id: string } | null = null
function scope(): string {
  const owner = $draftOwner.get()
  return JSON.stringify([draftOwnerKey(owner), owner.generation, owner.locked, localPrivacy.revision(draftOwnerKey(owner))])
}
let lastScope = scope()
function retire() {
  const next = scope()
  if (lastScope === next) return
  lastScope = next
  generation += 1
  attempt = null
  expiredEndpoint = null
  $webPush.set(initialState())
}
$draftOwner.listen(retire)
localPrivacy.$reset.listen(retire)

function patch(patch: Partial<WebPushState>) {
  const next = { ...$webPush.get(), ...patch }
  next.enabled = next.permission === 'granted' && next.local === 'present' && next.registration === 'confirmed'
  $webPush.set(next)
}
function context() {
  const captured = scope()
  const epoch = ++generation
  const token = sessionStorage.getItem('hermes.token')
  const current = () => captured === scope() && epoch === generation && !$draftOwner.get().locked
  const check = () => { if (!current()) throw new Error('Notification operation retired.') }
  return { captured, current, check, async request(path: string, body: unknown, method = 'POST') {
    check()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`/push/v1/${path}`, { method, body: JSON.stringify(body), credentials: 'include', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Hermes-Session-Token': token } : {}) } })
      check()
      if (!response.ok) throw new Error(response.status === 404 ? 'This relay needs an update for notification diagnostics.' : response.status === 401 || response.status === 403 ? 'Sign in again to verify notification registration.' : response.status === 409 ? 'Registration changed or belongs to another account. Disable this local subscription and enable again.' : response.status === 429 ? 'Wait 30 seconds before another test.' : 'Relay or verified account identity is unavailable. Check the server configuration and retry.')
      const value: unknown = await response.json()
      check()
      return value
    } finally { clearTimeout(timer) }
  } }
}
type Context = ReturnType<typeof context>
function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service worker did not become ready. Reload when safe and retry.')), 10000)
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
async function local(ctx: Context) {
  const registration = await bounded(navigator.serviceWorker.ready)
  ctx.check()
  const subscription = await bounded(registration.pushManager.getSubscription())
  ctx.check()
  patch({ local: !subscription ? 'missing' : subscription.endpoint === expiredEndpoint || subscription.expirationTime && subscription.expirationTime <= Date.now() ? 'expired' : 'present', permission: Notification.permission })
  return { registration, subscription }
}
function statusValue(value: unknown): { owner: string; registered: boolean; binding: string | null } {
  const data = value as Record<string, unknown> | null
  if (!data || data.version !== 2 || typeof data.owner !== 'string' || !/^[a-f0-9]{64}$/.test(data.owner) || typeof data.registered !== 'boolean' || !(data.binding === null || typeof data.binding === 'string' && data.binding.length > 0 && data.binding.length <= 100) || data.registered !== Boolean(data.binding)) throw new Error('The relay returned invalid notification diagnostics. Update the server and retry.')
  return data as { owner: string; registered: boolean; binding: string | null }
}
async function inspect(ctx: Context, subscription: PushSubscription | null) {
  const status = statusValue(await ctx.request('status', { endpoint: subscription?.endpoint ?? null }))
  patch({ owner: status.owner, binding: status.binding, registration: status.registered ? 'confirmed' : 'missing', relayAvailable: true })
  return status
}
async function run(action: (ctx: Context) => Promise<void>) {
  retire()
  if ($webPush.get().busy || webPushEnvironment() !== 'supported' || $draftOwner.get().locked) return
  const ctx = context()
  patch({ busy: true, error: null, permission: Notification.permission })
  try { await action(ctx) }
  catch (error) { if (ctx.current()) patch({ error: error instanceof Error ? error.message : 'Notification setup failed.', registration: 'unknown' }) }
  finally { if (ctx.current()) patch({ busy: false }) }
}
export async function refreshWebPushState(): Promise<void> {
  await run(async ctx => {
    patch({ registration: 'checking' })
    const { subscription } = await local(ctx)
    await inspect(ctx, subscription)
  })
}
function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const bytes = Uint8Array.from(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')), c => c.charCodeAt(0))
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('The relay provided an invalid push key.')
  return new Uint8Array(bytes.buffer)
}
async function publicKey(ctx: Context): Promise<Uint8Array<ArrayBuffer>> {
  // The public-key route is public and GET-only, but still needs a deadline.
  ctx.check()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch('/push/v1/public-key', { signal: controller.signal, redirect: 'error', credentials: 'include' })
    if (!response.ok) throw new Error('Web Push relay is unavailable.')
    const payload = await response.json() as { publicKey?: unknown; version?: unknown }
    ctx.check()
    if (payload.version !== 2 || typeof payload.publicKey !== 'string') throw new Error('Update the relay to enable account-bound notifications.')
    return applicationServerKey(payload.publicKey)
  } finally { clearTimeout(timer) }
}
export async function enableWebPush(): Promise<void> {
  await run(async ctx => {
    // This runs synchronously from the button gesture before any other awaits.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
    ctx.check()
    patch({ permission })
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked. Change this site or app permission in browser/OS settings.' : 'Permission was not granted. Use Enable notifications when ready.')
    const { registration, subscription: existing } = await local(ctx)
    const key = await publicKey(ctx)
    await inspect(ctx, existing) // verify identity before creating a subscription
    if (existing && (existing.endpoint === expiredEndpoint || existing.expirationTime && existing.expirationTime <= Date.now() || existing.options?.applicationServerKey && !equalKeys(existing.options.applicationServerKey, key))) {
      patch({ local: 'incompatible' })
      throw new Error('This local subscription expired or uses an old key. Disable it, then enable again.')
    }
    ctx.check()
    const subscription = existing ?? await bounded(registration.pushManager.subscribe({ applicationServerKey: key, userVisibleOnly: true }))
    ctx.check()
    patch({ local: 'present' })
    try {
      await ctx.request('subscriptions', subscription.toJSON(), 'PUT')
      await inspect(ctx, subscription)
    } catch (error) {
      if (!existing && ctx.current()) {
        const actual = await bounded(registration.pushManager.getSubscription())
        if (ctx.current() && actual?.endpoint === subscription.endpoint) {
          await bounded(subscription.unsubscribe())
          if (ctx.current()) patch({ local: 'unknown' })
        }
      }
      throw error
    }
  })
}
function equalKeys(value: ArrayBuffer, expected: Uint8Array): boolean {
  const bytes = new Uint8Array(value)
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])
}
export async function disableWebPush(): Promise<void> {
  await run(async ctx => {
    const { subscription } = await local(ctx)
    if (!subscription) { patch({ registration: 'missing', binding: null }); return }
    let remoteError: unknown
    try {
      const status = await inspect(ctx, subscription)
      if (status.binding) {
        const removed = await ctx.request('subscriptions', { endpoint: subscription.endpoint, binding: status.binding }, 'DELETE') as { removed?: unknown }
        if (removed.removed !== 1) throw new Error('Registration changed. Refresh status before disabling again.')
      }
      const latest = await inspect(ctx, subscription)
      if (latest.binding) throw new Error('Registration changed. Refresh status before disabling again.')
      patch({ registration: 'missing', binding: null })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Registration changed.')) throw error
      remoteError = error
    }
    ctx.check()
    await bounded(subscription.unsubscribe())
    ctx.check()
    const actual = await bounded(navigator.serviceWorker.ready.then(value => value.pushManager.getSubscription()))
    ctx.check()
    if (!actual) expiredEndpoint = null
    patch({ local: actual ? 'present' : 'missing' })
    if (actual) throw new Error('Remote removal completed or is unverified, but local unsubscribe did not finish. Retry Disable.')
    if (remoteError) throw new Error('Local subscription removed. Remote cleanup could not be verified; old expired registrations are pruned when sent. Permission remains unchanged.')
  })
}
export async function sendTestNotification(): Promise<void> {
  await run(async ctx => {
    const { subscription } = await local(ctx)
    const status = await inspect(ctx, subscription)
    if (!subscription || $webPush.get().local !== 'present' || Notification.permission !== 'granted' || !status.binding) throw new Error('Enable or repair this device registration before sending a test.')
    if (Date.now() < $webPush.get().retryAt) throw new Error('Wait 30 seconds before another test.')
    if (!attempt || attempt.scope !== ctx.captured || attempt.binding !== status.binding) attempt = { scope: ctx.captured, binding: status.binding, id: crypto.randomUUID() }
    patch({ test: 'sending', retryAt: Date.now() + 30000 })
    try {
      const result = await ctx.request('test', { binding: status.binding, requestId: attempt.id }) as { outcome?: unknown }
      if (!['accepted', 'expired', 'unknown'].includes(String(result?.outcome))) throw new Error('The relay returned an invalid test result.')
      if (result.outcome === 'expired') expiredEndpoint = subscription.endpoint
      patch({ test: result.outcome as 'accepted' | 'expired' | 'unknown', ...(result.outcome === 'expired' ? { registration: 'missing' as const, binding: null, local: 'expired' as const } : {}) })
      // A completed provider attempt is terminal. A new explicit test may send
      // again after cooldown; only an unresolved HTTP response reuses its key.
      attempt = null
    } catch (error) { if (ctx.current()) patch({ test: 'unknown' }); throw error }
  })
}

/** Notification URLs carry an opaque relay owner, never credentials or account names. */
export async function verifyNotificationOwner(owner: string): Promise<boolean> {
  const captured = scope()
  const token = sessionStorage.getItem('hermes.token')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch('/push/v1/status', { method: 'POST', credentials: 'include', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Hermes-Session-Token': token } : {}) }, body: JSON.stringify({ endpoint: null }) })
    if (!response.ok) return false
    return statusValue(await response.json()).owner === owner && captured === scope() && !$draftOwner.get().locked
  } catch { return false } finally { clearTimeout(timer) }
}
