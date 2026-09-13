import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = { native: true }
  return {
    state,
    addListener: vi.fn(),
    getLaunchUrl: vi.fn()
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.state.native,
    getPlatform: () => (mocks.state.native ? 'ios' : 'web')
  }
}))
vi.mock('@capacitor/app', () => ({
  App: { addListener: mocks.addListener, getLaunchUrl: mocks.getLaunchUrl }
}))

import { observeHermesDeepLinks } from '~/native/deep-links'

beforeEach(() => {
  mocks.state.native = true
  mocks.addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
  mocks.getLaunchUrl.mockReset().mockResolvedValue(undefined)
})

describe('observeHermesDeepLinks', () => {
  it('feeds a valid browser cold-start URL without observing later browser history', () => {
    mocks.state.native = false
    history.replaceState(null, '', '/session/cold?profile=work')
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)
    expect(handler).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/session/cold?profile=work`)

    history.pushState(null, '', '/session/warm')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(handler).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/session/cold?profile=work`)

    unsubscribe()
    history.pushState(null, '', '/session/ignored')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(handler).toHaveBeenCalledExactlyOnceWith(`${window.location.origin}/session/cold?profile=work`)
    expect(mocks.addListener).not.toHaveBeenCalled()
    expect(mocks.getLaunchUrl).not.toHaveBeenCalled()
  })

  it('does not reserve or interpret browser history entries', () => {
    mocks.state.native = false
    history.replaceState(null, '', '/')
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)

    history.pushState({ hermesScreen: 2, hermesDrawerBase: true }, '', '/session/internal')
    window.dispatchEvent(new PopStateEvent('popstate', { state: { hermesScreen: 2, hermesDrawerBase: true } }))
    history.pushState({ hermesScreen: 3 }, '', '/session/normal')
    window.dispatchEvent(new PopStateEvent('popstate', { state: { hermesScreen: 3 } }))

    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('forwards notification clicks from the service worker to an open PWA', () => {
    mocks.state.native = false
    history.replaceState(null, '', '/')
    const serviceWorker = new EventTarget()
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker })
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)

    const target = `${window.location.origin}/session/from-push?profile=work`
    serviceWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'HERMES_DEEP_LINK', url: target }
    }))
    expect(handler).toHaveBeenCalledExactlyOnceWith(target)
    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('')

    unsubscribe()
    serviceWorker.dispatchEvent(new MessageEvent('message', {
      data: { type: 'HERMES_DEEP_LINK', url: `${window.location.origin}/session/ignored` }
    }))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign and unsupported browser URLs', () => {
    mocks.state.native = false
    history.replaceState(null, '', '/settings')
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(handler).not.toHaveBeenCalled()
    unsubscribe()
  })

  it('handles the cold-start launch URL', async () => {
    mocks.getLaunchUrl.mockResolvedValue({ url: 'hermes://session/s-1' })
    const handler = vi.fn()
    observeHermesDeepLinks(handler)
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('hermes://session/s-1'))
  })

  it('forwards warm appUrlOpen events and removes the listener on unsubscribe', async () => {
    const remove = vi.fn()
    mocks.addListener.mockImplementation(() => Promise.resolve({ remove }))
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)

    await vi.waitFor(() => expect(mocks.addListener).toHaveBeenCalled())
    const warmOpen = mocks.addListener.mock.calls[0][1] as (event: { url: string }) => void
    warmOpen({ url: 'hermes://session/s-2' })
    expect(handler).toHaveBeenCalledWith('hermes://session/s-2')

    unsubscribe()
    await vi.waitFor(() => expect(remove).toHaveBeenCalled())
  })

  it('does not let a delayed cold-start URL replace a warm event', async () => {
    let finishLaunch: ((value: { url: string }) => void) | undefined
    mocks.getLaunchUrl.mockReturnValue(new Promise(resolve => { finishLaunch = resolve }))
    const handler = vi.fn()
    observeHermesDeepLinks(handler)
    await vi.waitFor(() => expect(mocks.addListener).toHaveBeenCalled())
    const warmOpen = mocks.addListener.mock.calls[0][1] as (event: { url: string }) => void

    warmOpen({ url: 'hermes://session/warm' })
    finishLaunch?.({ url: 'hermes://session/cold' })
    await Promise.resolve()

    expect(handler).toHaveBeenCalledExactlyOnceWith('hermes://session/warm')
  })

  it('suppresses a pending launch URL after unsubscribe', async () => {
    let finishLaunch: ((value: { url: string }) => void) | undefined
    mocks.getLaunchUrl.mockReturnValue(new Promise(resolve => { finishLaunch = resolve }))
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)

    unsubscribe()
    finishLaunch?.({ url: 'hermes://session/cold' })
    await Promise.resolve()

    expect(handler).not.toHaveBeenCalled()
  })

  it('swallows launch-url resolution failures', async () => {
    mocks.getLaunchUrl.mockRejectedValue(new Error('unavailable'))
    const handler = vi.fn()
    expect(() => observeHermesDeepLinks(handler)).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handler).not.toHaveBeenCalled()
  })
})