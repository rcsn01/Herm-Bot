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
  it('is a no-op on the web', () => {
    mocks.state.native = false
    const handler = vi.fn()
    const unsubscribe = observeHermesDeepLinks(handler)
    unsubscribe()
    expect(mocks.addListener).not.toHaveBeenCalled()
    expect(mocks.getLaunchUrl).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
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