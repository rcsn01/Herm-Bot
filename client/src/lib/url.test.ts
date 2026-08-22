import { describe, expect, it } from 'vitest'

import { absoluteGatewayURL, authModeForCredentials, authModeFromStatus, normalizeRemoteURL, providerAuthMethod } from '~/lib/url'

describe('normalizeRemoteURL', () => {
  it('normalizes a trusted HTTPS gateway and preserves a proxy prefix', () => {
    expect(normalizeRemoteURL(' https://agent.example/hermes/// ')).toBe('https://agent.example/hermes')
  })

  it('rejects credentials, queries, fragments, and non-web schemes', () => {
    expect(() => normalizeRemoteURL('https://user:pass@agent.example')).toThrow(/Credentials/)
    expect(() => normalizeRemoteURL('https://agent.example?token=secret')).toThrow(/query/)
    expect(() => normalizeRemoteURL('ftp://agent.example')).toThrow(/http/)
  })

  it('accepts HTTP for self-hosted gateways on encrypted overlays', () => {
    expect(normalizeRemoteURL('http://100.64.1.2:9119')).toBe('http://100.64.1.2:9119')
    expect(normalizeRemoteURL('http://localhost:8000/')).toBe('http://localhost:8000')
    expect(normalizeRemoteURL('http://localhost:8000/', true)).toBe('http://localhost:8000')
  })

  it('builds same-gateway API URLs below a proxy prefix', () => {
    expect(absoluteGatewayURL('https://agent.example/hermes', '/api/status')).toBe('https://agent.example/hermes/api/status')
  })
})

describe('authModeFromStatus', () => {
  it('selects interactive auth only when the gateway gate requires it', () => {
    expect(authModeFromStatus({ auth_required: true })).toBe('interactive')
    expect(authModeFromStatus({ auth_required: false })).toBe('token')
  })

  it('keeps a configured static gateway token as the explicit fallback', () => {
    expect(authModeForCredentials({ auth_required: true }, 'gateway-secret')).toBe('token')
    expect(authModeForCredentials({ auth_required: true }, '  ')).toBe('interactive')
  })

  it('selects password UI only for providers that advertise password support', () => {
    expect(providerAuthMethod({ supports_password: true })).toBe('password')
    expect(providerAuthMethod({ supports_password: false })).toBe('oauth')
  })
})
