import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Badge, Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { providerAuthMethod } from '~/lib/url'
import { HermesConnection, isNativeIOS } from '~/native/hermes-connection'
import { errorMessage } from '~/gateway/gateway-error'
import type { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'

interface AuthProvider {
  display_name: string
  name: string
  supports_password: boolean
}

export function ConnectScreen({ controller }: { controller: GatewayController }) {
  const connection = useStore($connection)
  const preferences = useStore($preferences)
  const native = isNativeIOS()
  const [remoteURL, setRemoteURL] = useState(preferences.remoteURL)
  const [token, setToken] = useState('')
  const [providers, setProviders] = useState<AuthProvider[]>([])
  const [passwordProvider, setPasswordProvider] = useState<AuthProvider | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const prepare = async () => {
    setBusy(true)
    setError(null)
    try {
      await controller.configure(remoteURL, token)
      if ($connection.get().authMode === 'interactive' && $connection.get().phase !== 'connected') {
        const result = await HermesConnection.request<{ providers: AuthProvider[] }>({ path: '/api/auth/providers' })
        setProviders(result.body.providers)
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setToken('')
      setBusy(false)
    }
  }

  const signIn = async (provider: AuthProvider) => {
    setBusy(true)
    setError(null)
    try {
      if (providerAuthMethod(provider) === 'password') {
        setPasswordProvider(provider)
        return
      }
      await controller.login(provider.name)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="connect-screen">
      <section className="connect-card">
        <BrandMark />
        <div>
          <Badge variant="muted">{native ? 'Remote iOS client' : 'Remote web app'}</Badge>
          <h1>Hermes Mobile</h1>
          <p>{native
            ? 'Enter your Hermes gateway URL to connect this iOS app.'
            : "Leave this page's origin to use the Docker proxy, or paste your Hermes Tailscale URL to talk to that instance directly."}</p>
        </div>

        <label>
          Remote gateway
          <Input
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="url"
            onChange={event => setRemoteURL(event.target.value)}
            placeholder="http://machine.tailnet.ts.net:9119"
            value={remoteURL}
          />
        </label>
        <label>
          Gateway token <span className="muted">(self-hosted only)</span>
          <Input
            autoCapitalize="none"
            onChange={event => setToken(event.target.value)}
            placeholder={native ? 'Stored in iOS Keychain' : 'Kept for this browser session only'}
            type="password"
            value={token}
          />
        </label>
        <Button className="touch-button" disabled={busy || !remoteURL.trim()} onClick={() => void prepare()}>
          {busy ? 'Connecting…' : 'Continue'}
        </Button>

        {providers.length > 0 && (
          <div className="provider-list">
            <p className="eyebrow">Sign in to this gateway</p>
            {providers.map(provider => (
              <Button className="touch-button" key={provider.name} onClick={() => void signIn(provider)} variant="secondary">
                {provider.supports_password ? 'Use password for' : 'Continue with'} {provider.display_name}
              </Button>
            ))}
            {passwordProvider && <PasswordForm controller={controller} provider={passwordProvider} />}
          </div>
        )}

        {(error || connection.error) && <div className="error-banner" role="alert">{error || connection.error}</div>}
        <p className="security-note">{native
          ? 'Tokens stay in Keychain; browser sessions stay in the native cookie jar.'
          : "Direct Tailscale URLs are fetched by this browser. On that Hermes instance, set dashboard.cors_origins to this page's origin. A gateway token always works; cookie sign-in works when both hosts are on the same tailnet MagicDNS."}</p>
      </section>
    </main>
  )
}

function PasswordForm({ controller, provider }: { controller: GatewayController; provider: AuthProvider }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      await controller.passwordLogin(provider.name, username, password)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  return (
    <form className="password-form" onSubmit={submit}>
      <Input autoComplete="username" onChange={event => setUsername(event.target.value)} placeholder="Username" value={username} />
      <Input autoComplete="current-password" disabled={busy} onChange={event => setPassword(event.target.value)} placeholder="Password" type="password" value={password} />
      <Button className="touch-button" disabled={busy || !password} type="submit">{busy ? 'Signing in…' : 'Sign in'}</Button>
      {error && <div className="error-banner">{error}</div>}
    </form>
  )
}
