import { Capacitor } from '@capacitor/core'

/** Fixed browser page scale, explicitly requested for the PWA. */
export function initializePageZoomLock(): () => void {
  if (Capacitor.isNativePlatform()) return () => undefined

  const root = document.documentElement
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!
  const originalViewport = viewport.content
  const originalZoom = root.getAttribute('data-page-zoom')
  viewport.content = `${originalViewport}, minimum-scale=1, maximum-scale=1, user-scalable=no`
  root.setAttribute('data-page-zoom', 'locked')

  const preventZoom = (event: Event) => event.preventDefault()
  const preventPinch = (event: TouchEvent) => {
    if (event.touches.length > 1) event.preventDefault()
  }
  // iOS may ignore viewport scale limits. Cancel WebKit pinch gestures too,
  // while leaving one-finger scrolling and normal input events untouched.
  const zoomEvents = ['gesturestart', 'gesturechange', 'gestureend', 'dblclick']
  for (const type of zoomEvents) document.addEventListener(type, preventZoom, { capture: true, passive: false })
  document.addEventListener('touchmove', preventPinch, { capture: true, passive: false })

  return () => {
    for (const type of zoomEvents) document.removeEventListener(type, preventZoom, true)
    document.removeEventListener('touchmove', preventPinch, true)
    viewport.content = originalViewport
    if (originalZoom === null) root.removeAttribute('data-page-zoom')
    else root.setAttribute('data-page-zoom', originalZoom)
  }
}
