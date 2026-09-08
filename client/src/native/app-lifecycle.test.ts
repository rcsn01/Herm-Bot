import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ native: true, addListener: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => mocks.native } }))
vi.mock('@capacitor/app', () => ({ App: { addListener: mocks.addListener } }))

import { observeAppLifecycle } from '~/native/app-lifecycle'

beforeEach(() => {
  mocks.native = true
  mocks.addListener.mockReset().mockResolvedValue({ remove: vi.fn() })
})

describe('observeAppLifecycle', () => {
  it('preserves the Capacitor appStateChange adapter', async () => {
    const handler = vi.fn()
    const remove = vi.fn()
    mocks.addListener.mockResolvedValue({ remove })
    const handle = await observeAppLifecycle(handler)
    expect(mocks.addListener).toHaveBeenCalledWith('appStateChange', handler)
    await handle.remove()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('maps browser lifecycle and connectivity events and cleans up', async () => {
    mocks.native = false
    const handler = vi.fn()
    const handle = await observeAppLifecycle(handler)

    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    expect(handler.mock.calls).toEqual([[{ isActive: false }], [{ isActive: true }]])

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('online'))
    expect(handler).toHaveBeenCalledTimes(3)
    window.dispatchEvent(new Event('pageshow'))
    expect(handler).toHaveBeenLastCalledWith({ isActive: true })

    await handle.remove()
    window.dispatchEvent(new Event('offline'))
    expect(handler).toHaveBeenCalledTimes(4)
  })
})
