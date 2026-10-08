import { Capacitor } from '@capacitor/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initializePageZoomLock } from './page-zoom'

let cleanup: (() => void) | undefined
const originalViewport = 'width=device-width, initial-scale=1, viewport-fit=cover'

beforeEach(() => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false)
  document.head.innerHTML = `<meta name="viewport" content="${originalViewport}">`
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.restoreAllMocks()
})

describe('PWA page zoom lock', () => {
  it('requests a fixed scale and restores viewport settings on cleanup', () => {
    cleanup = initializePageZoomLock()
    const meta = document.querySelector('meta[name="viewport"]')!
    expect(meta.getAttribute('content')).toContain('maximum-scale=1')
    expect(meta.getAttribute('content')).toContain('user-scalable=no')
    expect(document.documentElement.dataset.pageZoom).toBe('locked')
    cleanup()
    expect(meta.getAttribute('content')).toBe(originalViewport)
    expect(document.documentElement.dataset.pageZoom).toBeUndefined()
  })

  it('blocks WebKit zoom gestures and multi-touch movement, not single-touch scrolling', () => {
    cleanup = initializePageZoomLock()
    for (const type of ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']) {
      const event = new Event(type, { cancelable: true })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    for (const count of [1, 2]) {
      const event = Object.assign(new Event('touchmove', { cancelable: true }), { touches: Array(count).fill({}) })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(count > 1)
    }
  })

  it('removes gesture listeners on cleanup', () => {
    cleanup = initializePageZoomLock()
    cleanup()
    const event = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not change native app viewport settings or gestures', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true)
    cleanup = initializePageZoomLock()
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe(originalViewport)
    expect(document.documentElement.dataset.pageZoom).toBeUndefined()
    const event = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
