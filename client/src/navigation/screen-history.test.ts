import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $chat, emptyChatState } from '~/state/conversation'
import { $preferences } from '~/state/store'

import { $navigation, resetNavigation, setTab } from './navigation-store'
import { ROOT_ROUTES } from './routes'
import { installScreenHistory } from './screen-history'

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  resetNavigation('roster')
  $chat.set(emptyChatState())
  $preferences.set({ authMode: 'token', profile: null, remoteURL: 'https://gateway.test', theme: 'system' })
})

afterEach(() => {
  // vitest keeps spies across tests in a file; without this, an earlier
  // test's pushState spy accumulates the later tests' calls.
  vi.restoreAllMocks()
})

describe('screen history bridge', () => {
  it('restores the screen from a deep path on install', () => {
    window.history.replaceState(null, '', '/capabilities/mcp')
    const app = installScreenHistory()
    try {
      expect($navigation.get().activeTab).toBe('capabilities')
      expect($navigation.get().stacks.capabilities).toHaveLength(2)
    } finally {
      app.dispose()
    }
  })

  it('flags the entry the app loaded on without pushing', () => {
    const app = installScreenHistory()
    try {
      expect(window.location.pathname).toBe('/')
      expect((window.history.state as { hermesScreen?: number }).hermesScreen).toBe(1)
    } finally {
      app.dispose()
    }
  })

  it('mirrors forward navigation as a history entry', async () => {
    const app = installScreenHistory()
    try {
      setTab('cron')
      await flush()
      expect(window.location.pathname).toBe('/cron')
      expect((window.history.state as { hermesScreen?: number }).hermesScreen).toBe(2)
    } finally {
      app.dispose()
    }
  })

  it('leaves a session deep-link URL canonical for the sessions tab', async () => {
    window.history.replaceState(null, '', '/session/abc?profile=work')
    const app = installScreenHistory()
    try {
      setTab('sessions')
      await flush()
      expect(window.location.pathname).toBe('/session/abc')
      expect(window.location.search).toBe('?profile=work')
    } finally {
      app.dispose()
    }
  })

  it('reconciles a popstate target without pushing', async () => {
    const app = installScreenHistory()
    try {
      setTab('cron')
      await flush()
      const pushes = vi.spyOn(history, 'pushState')
      window.history.replaceState(window.history.state, '', '/settings/profiles')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      expect($navigation.get().activeTab).toBe('settings')
      expect($navigation.get().stacks.settings).toHaveLength(2)
      expect(pushes).not.toHaveBeenCalled()
    } finally {
      app.dispose()
    }
  })

  it('reconciles a popstate across tabs', async () => {
    const app = installScreenHistory()
    try {
      setTab('cron')
      await flush()
      window.history.replaceState(window.history.state, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      expect($navigation.get().activeTab).toBe('roster')
      expect($navigation.get().stacks.cron).toEqual([ROOT_ROUTES.cron])
    } finally {
      app.dispose()
    }
  })

  it('goes back through history while an app entry exists behind, else falls back', async () => {
    const app = installScreenHistory()
    try {
      const back = vi.spyOn(history, 'back')
      const fallback = vi.fn()

      app.goBack(fallback)
      expect(back).not.toHaveBeenCalled()
      expect(fallback).toHaveBeenCalledOnce()

      setTab('cron')
      await flush()
      app.goBack(fallback)
      expect(back).toHaveBeenCalledOnce()
      expect(fallback).toHaveBeenCalledOnce()
    } finally {
      app.dispose()
    }
  })

  it('stops mirroring after dispose', async () => {
    const app = installScreenHistory()
    app.dispose()
    const pushes = vi.spyOn(history, 'pushState')
    setTab('cron')
    await flush()
    expect(pushes).not.toHaveBeenCalled()
  })

  it('encodes the open conversation as a session deep-link URL', async () => {
    const app = installScreenHistory()
    try {
      setTab('sessions')
      $chat.set({ ...emptyChatState(), storedSessionId: 'saved-work' })
      await flush()
      // the default profile carries no ?profile parameter
      expect(window.location.pathname + window.location.search).toBe('/session/saved-work')
    } finally {
      app.dispose()
    }
  })

  it('carries the active profile on the session URL', async () => {
    $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.test', theme: 'system' })
    const app = installScreenHistory()
    try {
      setTab('sessions')
      $chat.set({ ...emptyChatState(), storedSessionId: 'saved-work' })
      await flush()
      expect(window.location.pathname + window.location.search).toBe('/session/saved-work?profile=work')
    } finally {
      app.dispose()
    }
  })

  it('keeps a canonical deep-link URL instead of pushing a duplicate', async () => {
    window.history.replaceState(null, '', '/session/saved-work?profile=work')
    $preferences.set({ authMode: 'token', profile: 'work', remoteURL: 'https://gateway.test', theme: 'system' })
    const pushes = vi.spyOn(history, 'pushState')
    const app = installScreenHistory()
    try {
      setTab('sessions')
      $chat.set({ ...emptyChatState(), storedSessionId: 'saved-work' })
      await flush()
      expect(pushes).not.toHaveBeenCalled()
      expect(window.location.pathname).toBe('/session/saved-work')
    } finally {
      app.dispose()
    }
  })

  it('falls back to the sessions root while a fresh conversation has no stored session', async () => {
    const app = installScreenHistory()
    try {
      setTab('sessions')
      $chat.set({ ...emptyChatState(), storedSessionId: null })
      await flush()
      expect(window.location.pathname).toBe('/sessions')
    } finally {
      app.dispose()
    }
  })

  it('does not re-push a session URL after reconciling back to the sessions root', async () => {
    const app = installScreenHistory()
    try {
      $chat.set({ ...emptyChatState(), storedSessionId: 'saved-work' })
      setTab('sessions')
      await flush()
      expect(window.location.pathname).toBe('/session/saved-work')

      window.history.replaceState(window.history.state, '', '/sessions')
      window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }))
      await flush()
      expect(window.location.pathname).toBe('/sessions')
    } finally {
      app.dispose()
    }
  })
})