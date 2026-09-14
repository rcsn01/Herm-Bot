import { applyPathState } from './navigation-store'
import { navigationFromPath } from './screen-url'

/** Restore one client route supplied at startup, without creating a history entry. */
export function restoreInitialNavigation(pathname: string): boolean {
  const parsed = navigationFromPath(pathname)
  if (!parsed) return false
  applyPathState(parsed.tab, parsed.stack)
  return true
}
