import { describe, expect, it } from 'vitest'

import { isAppShellNavigation } from './policy'

const request = (pathname: string, overrides = {}) => ({
  method: 'GET',
  mode: 'navigate',
  pathname,
  sameOrigin: true,
  ...overrides
})

describe('app shell navigation policy', () => {
  it.each(['/', '/session/abc', '/session/abc/'])('allows the bounded shell route %s', pathname => {
    expect(isAppShellNavigation(request(pathname))).toBe(true)
  })

  it.each(['/api', '/api/sessions', '/auth/callback', '/login', '/settings', '/session/a/more'])(
    'does not use the shell for %s',
    pathname => expect(isAppShellNavigation(request(pathname))).toBe(false)
  )

  it('rejects cross-origin, non-navigation, and non-GET requests', () => {
    expect(isAppShellNavigation(request('/', { sameOrigin: false }))).toBe(false)
    expect(isAppShellNavigation(request('/', { mode: 'cors' }))).toBe(false)
    expect(isAppShellNavigation(request('/', { method: 'POST' }))).toBe(false)
  })
})
