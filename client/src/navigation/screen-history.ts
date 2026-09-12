import { $navigation, applyPathState } from './navigation-store'
import { navigationFromPath, pathForTabRoute } from './screen-url'

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
 * Session deep links (`/session/<id>?profile=<p>`) stay canonical for the
 * sessions view — refreshing one re-runs the deep-link coordinator instead
 * of losing the session — so the bridge never rewrites them, and leaves
 * their popstate handling to the coordinator.
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
  let primed = false
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

  const unsubscribe = $navigation.subscribe(() => {
    // nanostores invokes the listener immediately; the store already matches
    // the restored URL at that point, so only react to later changes.
    if (!primed) {
      primed = true
      return
    }
    if (applying || pushQueued) return
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
      if (state.activeTab === 'sessions' && isSessionPath(window.location.pathname)) return
      if (window.location.pathname === path) return
      seq += 1
      history.pushState({ hermesScreen: seq }, '', path)
    })
  })

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
      unsubscribe()
    }
  }
}