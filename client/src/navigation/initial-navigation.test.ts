import { beforeEach, describe, expect, it } from 'vitest'

import { $navigation, resetNavigation } from './navigation-store'
import { restoreInitialNavigation } from './initial-navigation'

beforeEach(() => resetNavigation())

describe('restoreInitialNavigation', () => {
  it('restores a supported startup screen into the in-memory router', () => {
    expect(restoreInitialNavigation('/settings/model')).toBe(true)
    expect($navigation.get()).toMatchObject({
      activeTab: 'settings',
      stacks: { settings: [{ type: 'settings-root' }, { category: 'model', type: 'settings-category' }] }
    })
  })

  it('rejects session and unknown URLs for the deep-link coordinator', () => {
    expect(restoreInitialNavigation('/session/saved-work?profile=work')).toBe(false)
    expect(restoreInitialNavigation('/unknown')).toBe(false)
    expect($navigation.get().activeTab).toBe('roster')
  })
})
