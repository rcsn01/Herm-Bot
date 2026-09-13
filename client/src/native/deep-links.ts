import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import { parseHermesDeepLink } from '~/navigation/deep-links'

function isDrawerGuardState(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false
  const record = state as { hermesDrawer?: unknown; hermesDrawerBase?: unknown }
  return record.hermesDrawer === true || record.hermesDrawerBase === true
}

/**
 * Bridge iOS deep links (`hermes://` URLs opened via the app's URL scheme)
 * into a handler. Covers both cold start (`getLaunchUrl`) and warm taps
 * (`appUrlOpen`). Returns an unsubscribe function; no-op on the web so
 * browser dev sessions are unaffected.
 */
export function observeHermesDeepLinks(handler: (rawURL: string) => void): () => void {
  if (!Capacitor.isNativePlatform()) {
    let active = true
    const forwardCurrentURL = (event?: PopStateEvent) => {
      // The drawer guard also uses popstate. Its marked traversal is an
      // internal close, not a new external session deep link.
      if (event && isDrawerGuardState(event.state)) return
      const rawURL = window.location.href
      if (active && parseHermesDeepLink(rawURL)) handler(rawURL)
    }
    const forwardServiceWorkerURL = (event: MessageEvent) => {
      if (event.data?.type !== 'HERMES_DEEP_LINK' || typeof event.data.url !== 'string') return
      if (!active || !parseHermesDeepLink(event.data.url)) return
      history.replaceState(null, '', event.data.url)
      handler(event.data.url)
    }
    window.addEventListener('popstate', forwardCurrentURL)
    navigator.serviceWorker?.addEventListener('message', forwardServiceWorkerURL)
    forwardCurrentURL()
    return () => {
      active = false
      window.removeEventListener('popstate', forwardCurrentURL)
      navigator.serviceWorker?.removeEventListener('message', forwardServiceWorkerURL)
    }
  }

  let active = true
  let receivedWarmURL = false
  void App.getLaunchUrl()
    .then(launch => {
      if (active && !receivedWarmURL && launch?.url) handler(launch.url)
    })
    .catch(() => undefined)

  const subscription = App.addListener('appUrlOpen', event => {
    if (!active) return
    receivedWarmURL = true
    handler(event.url)
  })
  return () => {
    active = false
    void subscription
      .then(subscriptionHandle => subscriptionHandle.remove())
      .catch(() => undefined)
  }
}