import { afterEach, expect, it, vi } from 'vitest'
import { $networkStatus, observeNetworkStatus } from './network-status'
afterEach(() => vi.unstubAllGlobals())
it('uses initial evidence and updates until disposal', () => {
  const stop = observeNetworkStatus(window, { onLine: false })
  expect($networkStatus.get().status).toBe('offline')
  window.dispatchEvent(new Event('online'))
  expect($networkStatus.get().status).toBe('online')
  window.dispatchEvent(new Event('offline'))
  expect($networkStatus.get().status).toBe('offline')
  stop()
  window.dispatchEvent(new Event('online'))
  expect($networkStatus.get().status).toBe('offline')
})
it('missing platform evidence means unknown', () => {
  vi.stubGlobal('navigator', undefined)
  const stop = observeNetworkStatus()
  expect($networkStatus.get().status).toBe('unknown')
  stop()
})
