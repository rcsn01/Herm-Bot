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
  it('emits real visibility transitions without duplicate foreground events', async () => {
    mocks.native = false
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const handler = vi.fn()
    const handle = await observeAppLifecycle(handler)
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(handler.mock.calls).toEqual([[{ isActive: false }], [{ isActive: true }]])
    await handle.remove()
    visibility.mockRestore()
  })
  it('preserves the Capacitor appStateChange adapter', async () => {
    const handler = vi.fn()
    const remove = vi.fn()
    mocks.addListener.mockResolvedValue({ remove })
    const handle = await observeAppLifecycle(handler)
    expect(mocks.addListener).toHaveBeenCalledWith('appStateChange', handler)
    await handle.remove()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('maps browser page lifecycle but ignores connectivity events and cleans up', async () => {
    mocks.native = false
    const handler = vi.fn()
    const handle = await observeAppLifecycle(handler)

    window.dispatchEvent(new Event('offline'))
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('focus'))
    expect(handler).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('online'))
    expect(handler).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pageshow'))
    expect(handler).toHaveBeenLastCalledWith({ isActive: true })

    await handle.remove()
    window.dispatchEvent(new Event('offline'))
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
