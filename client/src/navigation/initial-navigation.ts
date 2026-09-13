import { applyPathState } from './navigation-store'
import { navigationFromPath } from './screen-url'

/** Restore a direct launch URL without adding to browser history. */
export function restoreInitialNavigation(): void {
  const parsed = navigationFromPath(window.location.pathname)
  if (parsed) applyPathState(parsed.tab, parsed.stack)
}
