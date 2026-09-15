import { isAppShellScreenPath } from '~/navigation/workspace-navigation'

export interface NavigationRequestPolicyInput {
  method: string
  mode: string
  sameOrigin: boolean
  pathname: string
}

/** The only requests the offline app shell may answer. */
export function isAppShellNavigation(input: NavigationRequestPolicyInput): boolean {
  if (input.method !== 'GET' || input.mode !== 'navigate' || !input.sameOrigin) return false
  if (/^\/(?:api|auth|login)(?:\/|$)/.test(input.pathname)) return false
  if (input.pathname === '/') return true
  return /^\/session\/[^/]+\/?$/.test(input.pathname) || isAppShellScreenPath(input.pathname)
}