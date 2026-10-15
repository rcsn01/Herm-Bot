/// <reference lib="webworker" />

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'

import { isAppShellNavigation } from './policy'
import { parsePushPayload } from './push-payload'
import { openNotificationTarget } from './notification-click'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision?: string; url: string }>
}

const buildShell = self.__WB_MANIFEST.filter(entry => {
  const url = typeof entry === 'string' ? entry : entry.url
  const pathname = new URL(url, self.location.origin).pathname
  return pathname === '/index.html' || pathname.startsWith('/assets/') || pathname.startsWith('/icons/')
})

precacheAndRoute(buildShell)
cleanupOutdatedCaches()

const appShell = createHandlerBoundToURL('/index.html')
registerRoute(
  ({ request, sameOrigin, url }: { request: Request; sameOrigin: boolean; url: URL }) =>
    isAppShellNavigation({
      method: request.method,
      mode: request.mode,
      pathname: url.pathname,
      sameOrigin
    }),
  appShell
)

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('push', event => {
  let value: unknown
  try {
    value = event.data?.json()
  } catch {
    value = event.data?.text()
  }
  const payload = parsePushPayload(value, self.location.origin)
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    data: { url: payload.url },
    icon: '/icons/icon-192.png',
    tag: payload.tag
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const payload = parsePushPayload({ url: event.notification.data?.url }, self.location.origin)
  const target = new URL(payload.url, self.location.origin).href
  event.waitUntil(openNotificationTarget(self.clients, target, self.location.origin))
})
