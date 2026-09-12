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
  return /^\/session\/[^/]+\/?$/.test(input.pathname) || isScreenPath(input.pathname)
}

/** Screen mirrors (roster, bot, sessions, capabilities, cron, settings) —
 *  every one is a pure client route, so the shell serves them offline too. */
function isScreenPath(pathname: string): boolean {
  return /^\/(?:bot|sessions|capabilities|cron|settings)(?:\/|$)/.test(pathname)
}
