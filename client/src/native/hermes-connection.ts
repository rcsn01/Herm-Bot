import { Capacitor, registerPlugin, WebPlugin } from '@capacitor/core'

import type { AuthMode, GatewayStatus, NativeIdentity, NativeResponse } from '~/lib/types'
import { absoluteGatewayURL, authModeForCredentials, normalizeRemoteURL } from '~/lib/url'

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
  contentType?: string
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
  login(options: NativeLoginOptions): Promise<NativeIdentity>
  logout(): Promise<void>
  openExternal(options: { url: string }): Promise<void>
  passwordLogin(options: PasswordLoginOptions): Promise<NativeIdentity>
  probe(): Promise<{ authMode: AuthMode; status: GatewayStatus }>
  request<T = unknown>(options: NativeRequestOptions): Promise<NativeResponse<T>>
  share(options: { path: string }): Promise<void>
  upload<T = unknown>(options: NativeUploadOptions): Promise<NativeResponse<T>>
}

const configuredDevGateway = typeof __HERMES_MOBILE_DEV_GATEWAY__ === 'string' ? __HERMES_MOBILE_DEV_GATEWAY__ : ''

class HermesConnectionWeb extends WebPlugin implements HermesConnectionPlugin {
  private remoteURL = localStorage.getItem('hermes.remoteURL') ?? ''
  private token = sessionStorage.getItem('hermes.token') ?? ''
  private authMode: AuthMode = 'token'

  async configure(options: ConfigureOptions) {
    this.remoteURL = normalizeRemoteURL(options.remoteURL, true)
    if (configuredDevGateway && this.remoteURL !== normalizeRemoteURL(configuredDevGateway, true)) {
      throw new Error(`Browser development is proxied to ${configuredDevGateway}. Enter that exact gateway URL or restart Vite with HERMES_MOBILE_DEV_GATEWAY set to this gateway.`)
    }
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
    return this.fetch<T>(withProfile(options.path, options.profile), options.method, options.body, options.timeoutMs)
  }

  async upload<T = unknown>(options: NativeUploadOptions) {
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const bytes = Uint8Array.from(atob(options.dataBase64), character => character.charCodeAt(0))
    const form = new FormData()
    form.append(options.field ?? 'file', new Blob([bytes], { type: options.contentType }), options.filename)
    const response = await fetch(this.httpURL(options.path), {
      body: form,
      credentials: 'include',
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {},
      method: 'POST'
    })
    const body = await response.json() as T
    if (!response.ok) throw new HermesHTTPError((body as { detail?: string }).detail || `Hermes returned HTTP ${response.status}`, response.status, body)
    return { body, headers: Object.fromEntries(response.headers), status: response.status }
  }

  async download(options: NativeDownloadOptions) {
    const response = await fetch(this.httpURL(withProfile(options.path, options.profile)), {
      credentials: 'include',
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {}
    })
    if (!response.ok) throw new HermesHTTPError(`Hermes returned HTTP ${response.status}`, response.status)
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (options.maxBytes && declaredSize > options.maxBytes) throw new Error('The download exceeds the allowed size.')
    const blob = await response.blob()
    if (options.maxBytes && blob.size > options.maxBytes) throw new Error('The download exceeds the allowed size.')
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = options.filename ?? 'download'
    anchor.click()
    URL.revokeObjectURL(url)
    return { filename: anchor.download, path: '', size: blob.size }
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
    const profile: Record<string, string> = options.profile ? { profile: options.profile } : {}
    if (this.authMode === 'interactive') {
      const response = await this.fetch<{ ticket: string }>('/api/auth/ws-ticket', 'POST')
      return { url: this.wsURL('/api/ws', { ...profile, ticket: response.body.ticket }) }
    }
    return { url: this.wsURL('/api/ws', { ...profile, token: this.token }) }
  }

  async login(_options: NativeLoginOptions): Promise<NativeIdentity> {
    throw new Error('Use an iOS simulator or device for native OAuth.')
  }

  async passwordLogin(options: PasswordLoginOptions): Promise<NativeIdentity> {
    await this.fetch('/auth/password-login', 'POST', options)
    const me = await this.fetch<NativeIdentity>('/api/auth/me')
    return me.body
  }

  async logout() {
    await this.fetch('/auth/logout', 'POST').catch(() => undefined)
  }

  async clearConnection() {
    this.remoteURL = ''
    this.token = ''
    localStorage.removeItem('hermes.remoteURL')
    sessionStorage.removeItem('hermes.token')
  }

  private async fetch<T>(path: string, method = 'GET', body?: unknown, timeoutMs = 30_000): Promise<NativeResponse<T>> {
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(this.httpURL(path), {
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'include',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { 'X-Hermes-Session-Token': this.token } : {})
        },
        method,
        signal: controller.signal
      })
      const raw = await response.text()
      const parsed = raw ? (JSON.parse(raw) as T) : ({} as T)
      if (!response.ok) {
        const detail = (parsed as { detail?: string }).detail
        throw new HermesHTTPError(detail || `Hermes returned HTTP ${response.status}`, response.status, parsed)
      }
      return { body: parsed, headers: Object.fromEntries(response.headers), status: response.status }
    } finally {
      window.clearTimeout(timer)
    }
  }

  private httpURL(path: string) {
    return configuredDevGateway ? new URL(path, window.location.origin).toString() : absoluteGatewayURL(this.remoteURL, path)
  }

  private wsURL(path: string, params: Record<string, string>) {
    const url = new URL(this.httpURL(path))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    return url.toString()
  }
}

export const HermesConnection = registerPlugin<HermesConnectionPlugin>('HermesConnection', {
  web: () => new HermesConnectionWeb()
})

function withProfile(path: string, profile?: null | string): string {
  if (!profile) return path
  const url = new URL(path, 'http://gateway.invalid')
  url.searchParams.set('profile', profile)
  return `${url.pathname}${url.search}`
}

export function validatedExternalURL(raw: string): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('Only HTTP and HTTPS URLs without embedded credentials can be opened.')
  }
  return url
}

export const isNativeIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
