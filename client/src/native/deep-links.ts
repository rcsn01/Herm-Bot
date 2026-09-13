import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import { parseHermesDeepLink } from '~/navigation/deep-links'

/**
 * Bridge iOS deep links (`hermes://` URLs opened via the app's URL scheme)
 * into a handler. Covers cold start (`getLaunchUrl`) and warm taps
 * (`appUrlOpen`). On the web, the current URL is treated as a cold-start
 * input and notification clicks are handled in memory without creating a
 * browser history entry.
 */
export function observeHermesDeepLinks(handler: (rawURL: string) => void): () => void {
  if (!Capacitor.isNativePlatform()) {
    let active = true
    const forwardCurrentURL = () => {
      const rawURL = window.location.href
      if (active && parseHermesDeepLink(rawURL)) handler(rawURL)
    }
    const forwardServiceWorkerURL = (event: MessageEvent) => {
      if (event.data?.type !== 'HERMES_DEEP_LINK' || typeof event.data.url !== 'string') return
      if (active && parseHermesDeepLink(event.data.url)) handler(event.data.url)
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
