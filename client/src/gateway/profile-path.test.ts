import { describe, expect, it } from 'vitest'

import { profileKey, profileParams, profilePath } from './profile-path'

describe('profile path helpers', () => {
  it('translates the local default profile to an explicit backend key', () => {
    expect(profileKey(null)).toBe('default')
    expect(profilePath('/api/config', null)).toBe('/api/config?profile=default')
    expect(profileParams(null, { limit: 10, q: 'two words' })).toBe('profile=default&limit=10&q=two+words')
  })

  it('preserves existing query parameters while replacing profile', () => {
    expect(profilePath('/api/skills/hub/search?q=old%20term&profile=wrong', 'client work/ios'))
      .toBe('/api/skills/hub/search?q=old+term&profile=client+work%2Fios')
  })
})
