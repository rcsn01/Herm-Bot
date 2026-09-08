import { Capacitor, registerPlugin, WebPlugin } from '@capacitor/core'

import type { AuthMode, GatewayStatus, NativeIdentity, NativeResponse } from '~/lib/types'
import { throwIfAborted } from '~/gateway/abort'
import { authModeForCredentials, absoluteGatewayURL, normalizeRemoteURL } from '~/lib/url'

export interface ConfigureOptions {
  remoteURL: string
  token?: string
}

export class HermesHTTPError extends Error {
  readonly body?: unknown
  readonly status: number

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'HermesHTTPError'
    this.status = status
    this.body = body
  }
}

export interface NativeRequestOptions {
  body?: unknown
  method?: string
  path: string
  profile?: null | string
  signal?: AbortSignal
  timeoutMs?: number
}

export interface NativeDownloadOptions {
  filename?: string
  maxBytes?: number
  path: string
  profile?: null | string
}

export interface NativeLoginOptions {
  provider: string
}

export interface NativeUploadOptions {
  dataBase64: string
  field?: string
  filename: string
  path: string
  profile?: null | string
  contentType?: string
  signal?: AbortSignal
}

export interface PasswordLoginOptions {
  password: string
  provider: string
  username: string
}

export interface HermesConnectionPlugin {
  clearConnection(): Promise<void>
  download(options: NativeDownloadOptions): Promise<{ filename: string; path: string; size: number }>
  configure(options: ConfigureOptions): Promise<{ remoteURL: string }>
  getAuthMode(): Promise<{ authMode: AuthMode }>
  getWebSocketURL(options?: { profile?: null | string }): Promise<{ url: string }>
  login(options: NativeLoginOptions): Promise<NativeIdentity | null>
  logout(): Promise<void>
  openExternal(options: { url: string }): Promise<void>
  passwordLogin(options: PasswordLoginOptions): Promise<NativeIdentity>
  probe(): Promise<{ authMode: AuthMode; status: GatewayStatus }>
  request<T = unknown>(options: NativeRequestOptions): Promise<NativeResponse<T>>
  share(options: { path: string }): Promise<void>
  upload<T = unknown>(options: NativeUploadOptions): Promise<NativeResponse<T>>
}

const configuredDevGateway = typeof __HERMES_MOBILE_DEV_GATEWAY__ === 'string' ? __HERMES_MOBILE_DEV_GATEWAY__ : ''

export class HermesConnectionWeb extends WebPlugin implements HermesConnectionPlugin {
  private remoteURL = defaultRemoteURL() || browserGatewayURL()
  private token = localStorage.getItem('hermes.remoteURL') === this.remoteURL ? sessionStorage.getItem('hermes.token') ?? '' : ''
  private authMode: AuthMode = 'token'

  constructor(private readonly navigate: (url: string) => void = url => window.location.assign(url)) {
    super()
  }

  async configure(options: ConfigureOptions) {
    const remoteURL = normalizeRemoteURL(options.remoteURL, true)
    this.remoteURL = remoteURL
    this.token = options.token?.trim() ?? ''
    localStorage.setItem('hermes.remoteURL', this.remoteURL)
    if (this.token) sessionStorage.setItem('hermes.token', this.token)
    else sessionStorage.removeItem('hermes.token')
    return { remoteURL: this.remoteURL }
  }

  async probe() {
    const response = await this.fetch<GatewayStatus>('/api/status')
    this.authMode = authModeForCredentials(response.body, this.token)
    return { authMode: this.authMode, status: response.body }
  }

  async request<T = unknown>(options: NativeRequestOptions) {
    return this.fetch<T>(withProfile(options.path, options.profile), options.method, options.body, options.timeoutMs, options.signal)
  }

  async upload<T = unknown>(options: NativeUploadOptions) {
    throwIfAborted(options.signal)
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const bytes = Uint8Array.from(atob(options.dataBase64), character => character.charCodeAt(0))
    const form = new FormData()
    form.append(options.field ?? 'file', new Blob([bytes], { type: options.contentType }), options.filename)
    const response = await fetch(this.httpURL(withProfile(options.path, options.profile)), {
      body: form,
      credentials: this.requestCredentials(),
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {},
      method: 'POST',
      redirect: 'error',
      signal: options.signal
    })
    return jsonResponse<T>(response)
  }

  async download(options: NativeDownloadOptions) {
    const response = await fetch(this.httpURL(withProfile(options.path, options.profile)), {
      credentials: this.requestCredentials(),
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {},
      redirect: 'error'
    })
    if (!response.ok) throw new HermesHTTPError(`Hermes returned HTTP ${response.status}`, response.status)
    const blob = await limitedDownload(response, options.maxBytes ?? 100 * 1024 * 1024)
    const filename = (options.filename || 'download').replace(/[\\/\\\\\x00-\x1f]/g, '_')
    const file = new File([blob], filename, { type: blob.type })
    if (navigator.share && navigator.canShare?.({ files: [file] }) && navigator.userActivation?.isActive) {
      try {
        await navigator.share({ files: [file] })
        return { filename, path: '', size: blob.size }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return { filename, path: '', size: blob.size }
        // Browsers may lose user activation during the download. Save instead.
      }
    }
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    // Safari needs the object URL to remain valid while it starts the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { filename, path: '', size: blob.size }
  }

  async openExternal(options: { url: string }) {
    const url = validatedExternalURL(options.url)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  async share(_options: { path: string }) {
    throw new Error('The native iOS share sheet is unavailable in this browser.')
  }

  async getAuthMode() {
    return { authMode: this.authMode }
  }

  async getWebSocketURL(options: { profile?: null | string } = {}) {
    const profile: Record<string, string> = { profile: options.profile ?? 'default' }
    if (this.authMode === 'interactive') {
      const response = await this.fetch<{ ticket: string }>('/api/auth/ws-ticket', 'POST')
      return { url: this.wsURL('/api/ws', { ...profile, ticket: response.body.ticket }) }
    }
    return { url: this.wsURL('/api/ws', { ...profile, token: this.token }) }
  }

  async login(options: NativeLoginOptions): Promise<null> {
    const url = new URL(this.httpURL('/auth/login'))
    url.searchParams.set('provider', options.provider)
    url.searchParams.set('next', `${window.location.pathname}${window.location.search}${window.location.hash}`)
    this.navigate(url.toString())
    return null
  }

  async passwordLogin(options: PasswordLoginOptions): Promise<NativeIdentity> {
    await this.fetch('/auth/password-login', 'POST', options)
    const me = await this.fetch<NativeIdentity>('/api/auth/me')
    return me.body
  }

  async logout() {
    try {
      const response = await fetch(this.httpURL('/auth/logout'), {
        credentials: this.requestCredentials(), method: 'POST', redirect: 'manual'
      })
      // The gateway expires its cookies and redirects to /login. Do not fetch
      // or parse that HTML page as JSON, or navigate out of the PWA on logout.
      if (!response.ok && response.type !== 'opaqueredirect' && response.status !== 302) {
        throw new HermesHTTPError('Gateway sign out failed. Reload to sign in again.', response.status)
      }
    } finally {
      this.token = ''
      sessionStorage.removeItem('hermes.token')
    }
  }

  async clearConnection() {
    this.remoteURL = browserGatewayURL()
    this.token = ''
    localStorage.removeItem('hermes.remoteURL')
    sessionStorage.removeItem('hermes.token')
  }

  private async fetch<T>(path: string, method = 'GET', body?: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<NativeResponse<T>> {
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    const timer = window.setTimeout(() => controller.abort(), timeoutMs)
    if (signal?.aborted) abort()
    try {
      const response = await fetch(this.httpURL(path), {
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: this.requestCredentials(),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { 'X-Hermes-Session-Token': this.token } : {})
        },
        method,
        redirect: 'error',
        signal: controller.signal
      })
      return await jsonResponse<T>(response)
    } catch (error) {
      if (error instanceof TypeError && !usesBrowserGatewayProxy(this.remoteURL)) {
        throw new Error('This browser could not reach that Hermes URL. Use this site\'s URL so the Docker proxy contacts Hermes.')
      }
      throw error
    } finally {
      window.clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  private requestCredentials(): RequestCredentials {
    return usesBrowserGatewayProxy(this.remoteURL) ? 'include' : 'omit'
  }

  private httpURL(path: string) {
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const base = usesBrowserGatewayProxy(this.remoteURL) ? window.location.origin : this.remoteURL
    const url = new URL(absoluteGatewayURL(base, path))
    const expected = new URL(base)
    if (!path.startsWith('/') || url.origin !== expected.origin || url.username || url.password) {
      throw new Error(usesBrowserGatewayProxy(this.remoteURL)
        ? 'Gateway requests must stay on this app origin.'
        : 'Gateway requests must stay on the configured gateway origin.')
    }
    return url.toString()
  }

  private wsURL(path: string, params: Record<string, string>) {
    const url = new URL(this.httpURL(path))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    return url.toString()
  }
}

function browserGatewayURL(): string {
  return normalizeRemoteURL(configuredDevGateway || window.location.origin, true)
}

/** Same-origin nginx/Vite proxy, including the development gateway rewrite. */
export function usesBrowserGatewayProxy(remoteURL: string): boolean {
  const configured = normalizeRemoteURL(remoteURL, true)
  if (configured === normalizeRemoteURL(window.location.origin, true)) return true
  return Boolean(configuredDevGateway) && configured === normalizeRemoteURL(configuredDevGateway, true)
}

export function defaultRemoteURL(): string {
  const stored = localStorage.getItem('hermes.remoteURL') ?? ''
  if (Capacitor.isNativePlatform()) return stored
  const origin = browserGatewayURL()
  if (!stored) return origin
  try {
    const normalized = normalizeRemoteURL(stored, true)
    return usesBrowserGatewayProxy(normalized) ? normalized : origin
  } catch {
    return origin
  }
}

async function jsonResponse<T>(response: Response): Promise<NativeResponse<T>> {
  const raw = await response.text()
  let body: T
  try {
    body = raw ? JSON.parse(raw) as T : {} as T
  } catch {
    throw new HermesHTTPError(
      response.ok ? 'Expected a Hermes response. Reload to sign in, or check the gateway proxy.' : `Hermes returned HTTP ${response.status}`,
      response.status
    )
  }
  if (!response.ok) {
    const detail = (body as { detail?: unknown } | null)?.detail
    throw new HermesHTTPError(typeof detail === 'string' ? detail : `Hermes returned HTTP ${response.status}`, response.status, body)
  }
  return { body, headers: Object.fromEntries(response.headers), status: response.status }
}

async function limitedDownload(response: Response, maxBytes: number): Promise<Blob> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel()
    throw new Error('The download exceeds the allowed size.')
  }
  const reader = response.body?.getReader()
  if (!reader) return new Blob([])
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new Error('The download exceeds the allowed size.')
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  return new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' })
}

export const HermesConnection = registerPlugin<HermesConnectionPlugin>('HermesConnection', {
  web: () => new HermesConnectionWeb()
})

export function withProfile(path: string, profile?: null | string): string {
  // Preserve a profile already translated into the path by profilePath(). The
  // native bridge receives that path but does not receive a second profile
  // argument. An omitted profile means this is an installation-wide route, so
  // do not add a misleading default-profile query parameter.
  const url = new URL(path, 'http://gateway.invalid')
  if (!path.startsWith('/') || url.origin !== 'http://gateway.invalid' || url.username || url.password) {
    throw new Error('Gateway requests require a same-origin path.')
  }
  if (profile !== undefined) url.searchParams.set('profile', profile ?? 'default')
  return `${url.pathname}${url.search}${url.hash}`
}

export function validatedExternalURL(raw: string): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('Only HTTP and HTTPS URLs without embedded credentials can be opened.')
  }
  return url
}

export const isNativeIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
