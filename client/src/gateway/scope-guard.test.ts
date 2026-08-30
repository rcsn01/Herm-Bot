import { afterEach, describe, expect, it } from 'vitest'

import { currentGatewayScope, isCurrentGatewayScope } from './scope-guard'
import { $preferences } from '~/state/store'

const originalPreferences = $preferences.get()

afterEach(() => $preferences.set(originalPreferences))

describe('gateway scope guard', () => {
  it('invalidates a stale operation even after returning to the same profile', () => {
    $preferences.set({ ...originalPreferences, remoteURL: 'https://gateway.example', profile: 'alpha' })
    const alpha = currentGatewayScope()

    $preferences.set({ ...$preferences.get(), profile: 'beta' })
    expect(isCurrentGatewayScope(alpha)).toBe(false)

    $preferences.set({ ...$preferences.get(), profile: 'alpha' })
    const returned = currentGatewayScope()
    expect(returned.generation).not.toBe(alpha.generation)
    expect(isCurrentGatewayScope(alpha)).toBe(false)
    expect(isCurrentGatewayScope(returned)).toBe(true)
  })
})
