import { Capacitor, registerPlugin, WebPlugin } from '@capacitor/core'

import type { AuthMode, GatewayStatus, NativeIdentity, NativeResponse } from '~/lib/types'
import { absoluteGatewayURL, authModeForCredentials, normalizeRemoteURL } from '~/lib/url'

export interface ConfigureOptions {
  remoteURL: string
  token?: string
}

export interface NativeRequestOptions {
  body?: unknown
  method?: string
  path: string
  timeoutMs?: number
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
  configure(options: ConfigureOptions): Promise<{ remoteURL: string }>
  getAuthMode(): Promise<{ authMode: AuthMode }>
  getWebSocketURL(options?: { profile?: null | string }): Promise<{ url: string }>
  login(options: NativeLoginOptions): Promise<NativeIdentity>
  logout(): Promise<void>
  passwordLogin(options: PasswordLoginOptions): Promise<NativeIdentity>
  probe(): Promise<{ authMode: AuthMode; status: GatewayStatus }>
  request<T = unknown>(options: NativeRequestOptions): Promise<NativeResponse<T>>
  upload<T = unknown>(options: NativeUploadOptions): Promise<NativeResponse<T>>
}

class HermesConnectionWeb extends WebPlugin implements HermesConnectionPlugin {
  private remoteURL = localStorage.getItem('hermes.remoteURL') ?? ''
  private token = sessionStorage.getItem('hermes.token') ?? ''
  private authMode: AuthMode = 'token'

  async configure(options: ConfigureOptions) {
    this.remoteURL = normalizeRemoteURL(options.remoteURL, true)
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
    return this.fetch<T>(options.path, options.method, options.body, options.timeoutMs)
  }

  async upload<T = unknown>(options: NativeUploadOptions) {
    if (!this.remoteURL) throw new Error('Configure a gateway first.')
    const bytes = Uint8Array.from(atob(options.dataBase64), character => character.charCodeAt(0))
    const form = new FormData()
    form.append(options.field ?? 'file', new Blob([bytes], { type: options.contentType }), options.filename)
    const response = await fetch(absoluteGatewayURL(this.remoteURL, options.path), {
      body: form,
      credentials: 'include',
      headers: this.token ? { 'X-Hermes-Session-Token': this.token } : {},
      method: 'POST'
    })
    const body = await response.json() as T
    if (!response.ok) throw new Error((body as { detail?: string }).detail || `Hermes returned HTTP ${response.status}`)
    return { body, headers: Object.fromEntries(response.headers), status: response.status }
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
      const response = await fetch(absoluteGatewayURL(this.remoteURL, path), {
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
        throw new Error(detail || `Hermes returned HTTP ${response.status}`)
      }
      return { body: parsed, headers: Object.fromEntries(response.headers), status: response.status }
    } finally {
      window.clearTimeout(timer)
    }
  }

  private wsURL(path: string, params: Record<string, string>) {
    const url = new URL(absoluteGatewayURL(this.remoteURL, path))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
    return url.toString()
  }
}

export const HermesConnection = registerPlugin<HermesConnectionPlugin>('HermesConnection', {
  web: () => new HermesConnectionWeb()
})

export const isNativeIOS = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
