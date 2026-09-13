import { $chat } from '~/state/conversation'
import { $preferences } from '~/state/store'

import { $navigation, applyPathState } from './navigation-store'
import { navigationFromPath, pathForTabRoute, sessionPath } from './screen-url'

/**
 * Mirror in-memory navigation into browser history so every screen owns a
 * URI: forward navigation pushes an entry, popstate reconciles the store
 * (which is what the Android system back and browser back ride on), and
 * in-app back goes through history.back() while an app entry sits behind.
 *
 * The browser history is linear while the app keeps per-tab stacks; each
 * entry carries a monotonically increasing marker, and the smallest marker
 * ever seen marks the boundary: going back past it would leave the app, so
 * in-app back falls back to the caller's action there.
 *
 * The sessions view mirrors the open conversation as a canonical session
 * deep link (`/session/<id>?profile=<p>`, `?profile=` omitted for the
 * default profile): resuming a session — from the roster, the drawer, cron
 * runs, or the deep-link coordinator — pushes its URL, while a fresh
 * conversation without a stored id yet stays on the generic `/sessions`.
 * Reconciling back to a non-session URL keeps the open conversation in
 * memory but never re-pushes the session URL behind it (the back gesture
 * must win), and the bridge never downgrades a canonical session URL to
 * `/sessions` — a stored id appearing later upgrades it again.
 */

interface ScreenEntryState {
  hermesScreen?: number
}

export interface ScreenHistory {
  goBack(fallback: () => void): void
  dispose(): void
}

function entrySeq(state: unknown): number | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const marker = (state as ScreenEntryState).hermesScreen
  return typeof marker === 'number' ? marker : undefined
}

function isSessionPath(pathname: string): boolean {
  return pathname === '/session' || pathname.startsWith('/session/')
}

export function installScreenHistory(): ScreenHistory {
  let seq = 0
  let boundarySeq = Number.MAX_SAFE_INTEGER
  let applying = false
  let pushQueued = false
  let disposed = false

  const existing = entrySeq(history.state)
  if (existing === undefined) {
    seq += 1
    history.replaceState({ hermesScreen: seq }, '', window.location.href)
    boundarySeq = seq
  } else {
    seq = existing
    boundarySeq = existing
  }

  const restore = (pathname: string): void => {
    const parsed = navigationFromPath(pathname)
    if (!parsed) return
    applying = true
    try {
      applyPathState(parsed.tab, parsed.stack)
    } finally {
      applying = false
    }
  }

  restore(window.location.pathname)

  const onPop = (event: PopStateEvent): void => {
    const landed = entrySeq(event.state)
    if (landed !== undefined) {
      seq = landed
      boundarySeq = Math.min(boundarySeq, landed)
    }
    restore(window.location.pathname)
  }
  window.addEventListener('popstate', onPop)

  const sync = (): void => {
    if (applying || pushQueued || disposed) return
    pushQueued = true
    queueMicrotask(() => {
      pushQueued = false
      if (disposed) return
      const state = $navigation.get()
      const stack = state.stacks[state.activeTab]
      const top = stack[stack.length - 1]
      let path: string
      try {
        path = pathForTabRoute(state.activeTab, top)
      } catch {
        return
      }
      if (state.activeTab === 'sessions') {
        const storedSessionId = $chat.get().storedSessionId
        if (storedSessionId) {
          // The open conversation owns a canonical session URL.
          path = sessionPath(storedSessionId, $preferences.get().profile)
        } else if (isSessionPath(window.location.pathname)) {
          // Never overwrite a canonical deep-link URL with the generic root
          // while the conversation has no stored id (e.g. the coordinator set
          // the tab before its resume completes).
          return
        }
      }
      if (window.location.pathname + window.location.search === path) return
      seq += 1
      history.pushState({ hermesScreen: seq }, '', path)
    })
  }

  let primed = false
  const unsubscribeNavigation = $navigation.subscribe(() => {
    // nanostores invokes the listener immediately; the store already matches
    // the restored URL at that point, so only react to later changes.
    if (!primed) {
      primed = true
      return
    }
    sync()
  })
  // Conversation changes (resume, new session, the gateway assigning a
  // stored id) may move the URL without any navigation-store change. The
  // immediate first call is a no-op via the URL equality check above.
  const unsubscribeChat = $chat.subscribe(sync)

  return {
    goBack(fallback: () => void): void {
      const here = entrySeq(history.state)
      if (here !== undefined && here > boundarySeq) {
        history.back()
        return
      }
      fallback()
    },
    dispose(): void {
      disposed = true
      window.removeEventListener('popstate', onPop)
      unsubscribeNavigation()
      unsubscribeChat()
    }
  }
}