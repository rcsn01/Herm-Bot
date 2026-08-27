import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

/**
 * Bridge iOS deep links (`hermes://` URLs opened via the app's URL scheme)
 * into a handler. Covers both cold start (`getLaunchUrl`) and warm taps
 * (`appUrlOpen`). Returns an unsubscribe function; no-op on the web so
 * browser dev sessions are unaffected.
 */
export function observeHermesDeepLinks(handler: (rawURL: string) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {}

  void App.getLaunchUrl()
    .then(launch => {
      if (launch?.url) handler(launch.url)
    })
    .catch(() => undefined)

  const subscription = App.addListener('appUrlOpen', event => handler(event.url))
  return () => {
    void subscription
      .then(subscriptionHandle => subscriptionHandle.remove())
      .catch(() => undefined)
  }
}