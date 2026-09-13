import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $navigation, resetNavigation, setTab } from './navigation-store'
import { restoreInitialNavigation } from './initial-navigation'

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  resetNavigation('roster')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initial navigation', () => {
  it('restores a direct URL without rewriting it', () => {
    window.history.replaceState(null, '', '/capabilities/mcp')
    const replaceState = vi.spyOn(window.history, 'replaceState')

    restoreInitialNavigation()

    expect($navigation.get().activeTab).toBe('capabilities')
    expect($navigation.get().stacks.capabilities).toHaveLength(2)
    expect(window.location.pathname).toBe('/capabilities/mcp')
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('leaves browser history untouched during in-app navigation', async () => {
    const pushState = vi.spyOn(window.history, 'pushState')
    const replaceState = vi.spyOn(window.history, 'replaceState')
    const back = vi.spyOn(window.history, 'back')

    restoreInitialNavigation()
    setTab('cron')
    await flush()

    expect(window.location.pathname).toBe('/')
    expect(pushState).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
  })
})
