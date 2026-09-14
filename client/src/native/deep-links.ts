import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import { parseHermesDeepLink } from '~/navigation/deep-links'

/**
 * Bridge iOS deep links (`hermes://` URLs opened via the app's URL scheme)
 * into a handler. Covers both cold start (`getLaunchUrl`) and warm taps
 * (`appUrlOpen`). Returns an unsubscribe function; no-op on the web so
 * browser dev sessions are unaffected.
 */
export function observeHermesDeepLinks(handler: (rawURL: string) => void): () => void {
  if (!Capacitor.isNativePlatform()) {
    let active = true
    const forwardCurrentURL = () => {
      const rawURL = window.location.href
      if (!active || !parseHermesDeepLink(rawURL)) return
      handler(rawURL)
      // A web deep link is an input to the in-memory router, not a client
      // route. Keep the document at the shell root without adding history.
      history.replaceState(null, '', '/')
    }
    const forwardServiceWorkerURL = (event: MessageEvent) => {
      if (event.data?.type !== 'HERMES_DEEP_LINK' || typeof event.data.url !== 'string') return
      if (!active || !parseHermesDeepLink(event.data.url)) return
      handler(event.data.url)
    }
    navigator.serviceWorker?.addEventListener('message', forwardServiceWorkerURL)
    forwardCurrentURL()
    return () => {
      active = false
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
