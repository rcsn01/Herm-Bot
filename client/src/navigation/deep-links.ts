import { atom } from 'nanostores'

import { setTab } from '~/navigation/navigation-store'

/**
 * Deep links into the app, e.g. `hermes://session/<id>` from a Bark push
 * notification. The iOS side registers the `hermes` URL scheme in
 * ios/App/App/Info.plist; the `@capacitor/app` plugin forwards opens here.
 */
export interface HermesDeepLink {
  kind: 'session'
  sessionId: string
}

/** Link observed but not yet applied (the gateway may still be connecting). */
export const $pendingDeepLink = atom<HermesDeepLink | null>(null)

/** Parse a raw hermes:// URL. Returns null for anything the app can't act on. */
export function parseHermesDeepLink(raw: string): HermesDeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'hermes:') return null

  // `hermes://session/<id>` parses with host 'session'; tolerate the
  // single-slash `hermes:/session/<id>` spelling too.
  const segments = (url.host ? `${url.host}${url.pathname}` : url.pathname).split('/').filter(Boolean)
  if (segments.length !== 2 || segments[0] !== 'session') return null
  const [, sessionId] = segments
  return sessionId ? { kind: 'session', sessionId } : null
}

/** Queue a raw URL for handling once the gateway is connected. True if accepted. */
export function queueDeepLink(raw: string): boolean {
  const link = parseHermesDeepLink(raw)
  if (!link) return false
  $pendingDeepLink.set(link)
  return true
}

export interface DeepLinkController {
  resumeSession(sessionId: string): Promise<unknown>
}

/**
 * Apply the pending link: open the referenced conversation, exactly like the
 * sessions list does (resume into the chat tab). If the session is gone,
 * fall back to the sessions list. Returns true when the link was applied.
 */
export async function consumePendingDeepLink(controller: DeepLinkController): Promise<boolean> {
  const link = $pendingDeepLink.get()
  if (!link) return false
  $pendingDeepLink.set(null)
  try {
    await controller.resumeSession(link.sessionId)
    setTab('chat')
    return true
  } catch {
    setTab('sessions')
    return false
  }
}