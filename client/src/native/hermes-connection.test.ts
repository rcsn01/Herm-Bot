import { describe, expect, it } from 'vitest'

import { withProfile } from './hermes-connection'

describe('native gateway request scoping', () => {
  it('leaves installation-wide paths unscoped', () => {
    expect(withProfile('/api/status')).toBe('/api/status')
    expect(withProfile('/api/auth/me')).toBe('/api/auth/me')
  })

  it('preserves an already-scoped path and translates an explicit default', () => {
    expect(withProfile('/api/config?profile=work', undefined)).toBe('/api/config?profile=work')
    expect(withProfile('/api/config', null)).toBe('/api/config?profile=default')
    expect(withProfile('/api/config?profile=old', 'work')).toBe('/api/config?profile=work')
  })
})
