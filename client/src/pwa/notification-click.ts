interface PushWindow {
  url: string
  focus(): Promise<unknown>
  postMessage(message: unknown): void
}
interface PushClients {
  matchAll(options: { includeUncontrolled: boolean; type: 'window' }): Promise<readonly PushWindow[]>
  openWindow(url: string): Promise<{ focus(): Promise<unknown> } | null>
}
export async function openNotificationTarget(clients: PushClients, target: string, origin: string): Promise<void> {
  const windows = await clients.matchAll({ includeUncontrolled: false, type: 'window' })
  const existing = windows.find(client => {
    const url = new URL(client.url)
    return url.origin === origin && (url.pathname === '/' || url.pathname.startsWith('/session/'))
  })
  if (existing) {
    try {
      await existing.focus()
      existing.postMessage({ type: 'HERMES_DEEP_LINK', url: target })
      return
    } catch { /* A window may close between enumeration and focus. */ }
  }
  const opened = await clients.openWindow(target)
  await opened?.focus()
}
