import { describe, expect, it, vi } from 'vitest'
import { openNotificationTarget } from './notification-click'
describe('notification click handoff', () => {
  it('focuses and messages one controlled same-app window without a reload or duplicate', async () => {
    const window = { url: 'https://mobile.example/', focus: vi.fn(async () => undefined), postMessage: vi.fn() }
    const clients = { matchAll: vi.fn(async () => [window]), openWindow: vi.fn(async () => null) }
    await openNotificationTarget(clients, 'https://mobile.example/session/a', 'https://mobile.example')
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.postMessage).toHaveBeenCalledOnce()
    expect(clients.openWindow).not.toHaveBeenCalled()
    expect(clients.matchAll).toHaveBeenCalledWith({ includeUncontrolled: false, type: 'window' })
  })
  it('uses one cold window when no controlled app window exists', async () => {
    const focus = vi.fn(async () => undefined)
    const clients = { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => ({ focus })) }
    await openNotificationTarget(clients, 'https://mobile.example/', 'https://mobile.example')
    expect(clients.openWindow).toHaveBeenCalledExactlyOnceWith('https://mobile.example/')
    expect(focus).toHaveBeenCalledOnce()
  })
})
