/**
 * The mobile UI represents the default profile as `null`, while the HTTP
 * gateway uses the literal `default` profile key.  Keep that translation in
 * one place: several list endpoints use `all` when profile is omitted.
 */
export const DEFAULT_PROFILE = 'default'

export type MobileProfile = null | string

export function profileKey(profile: MobileProfile | undefined): string {
  return profile ?? DEFAULT_PROFILE
}

/** Add an explicit profile query parameter without losing existing params. */
export function profilePath(path: string, profile: MobileProfile | undefined): string {
  const url = new URL(path, 'http://hermes.mobile')
  url.searchParams.set('profile', profileKey(profile))
  return `${url.pathname}${url.search}${url.hash}`
}

/** Build a URLSearchParams object for APIs that need additional query fields. */
export function profileParams(profile: MobileProfile | undefined, params: Record<string, string | number | undefined> = {}): string {
  const search = new URLSearchParams({ profile: profileKey(profile) })
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  return search.toString()
}
