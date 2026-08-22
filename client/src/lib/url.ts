export function normalizeRemoteURL(input: string, allowLocalHTTP = false): string {
  void allowLocalHTTP // retained for call-site compatibility; HTTP is now generally allowed
  const candidate = input.trim()
  if (!candidate) throw new Error('Enter your remote Hermes URL.')

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('Enter a complete URL, for example https://hermes.example.com.')
  }

  if (url.username || url.password) throw new Error('Credentials are not allowed in the URL.')
  if (url.search || url.hash) throw new Error('The gateway URL cannot contain a query or fragment.')
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Enter a gateway URL starting with http:// or https://.')
  }

  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

export function absoluteGatewayURL(base: string, path: string): string {
  const root = normalizeRemoteURL(base, true)
  return `${root}${path.startsWith('/') ? path : `/${path}`}`
}

export function authModeFromStatus(status: Pick<GatewayStatusShape, 'auth_required'>): 'interactive' | 'token' {
  return status.auth_required ? 'interactive' : 'token'
}

export function authModeForCredentials(
  status: Pick<GatewayStatusShape, 'auth_required'>,
  token: string
): 'interactive' | 'token' {
  return token.trim() ? 'token' : authModeFromStatus(status)
}

export function providerAuthMethod(provider: { supports_password: boolean }): 'oauth' | 'password' {
  return provider.supports_password ? 'password' : 'oauth'
}

interface GatewayStatusShape {
  auth_required: boolean
}
