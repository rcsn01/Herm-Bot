import {
  CAPABILITY_SECTIONS,
  ROOT_ROUTES,
  SETTINGS_ADMINISTRATION_PAGES,
  SETTINGS_CATEGORIES,
  type CapabilitySection,
  type MobileRoute,
  type MobileTab,
  type SettingsAdministrationPage,
  type SettingsCategory
} from './routes'

/**
 * One path per screen, extending the existing session deep-link contract
 * (`/session/<id>?profile=<p>` stays owned by the deep-link coordinator):
 *
 *   /                          roster root
 *   /sessions                  sessions root (the active conversation)
 *   /capabilities[/section[/id]]
 *   /cron[/blueprints|/<job>[/edit]|/new]
 *   /settings/<category|page>
 *
 * The active profile is global (persisted preferences), so screen paths don't
 * carry it. Open conversations DO: while a stored session is on screen the
 * sessions view mirrors the session deep-link namespace
 * (`/session/<id>?profile=<p>`, `?profile=` omitted for the default profile)
 * so a conversation can be reloaded or shared like any other screen.
 */

/** Canonical URI for an open conversation — the deep-link namespace the
 *  coordinator owns, shaped like the desktop's session links. */
export function sessionPath(storedSessionId: string, profile: null | string): string {
  const path = `/session/${encodeURIComponent(storedSessionId)}`
  return profile ? `${path}?profile=${encodeURIComponent(profile)}` : path
}

export function pathForTabRoute(tab: MobileTab, route: MobileRoute): string {
  if (route.tab !== tab) {
    throw new Error(`Cannot render a ${route.tab} route under the ${tab} tab`)
  }
  switch (route.type) {
    case 'roster-root':
      return '/'
    case 'group-room':
      return `/group/${encodeURIComponent(route.roomId)}`
    case 'sessions-root':
      return '/sessions'
    case 'capabilities-root':
      return '/capabilities'
    case 'capabilities-section':
      return `/capabilities/${route.section}`
    case 'capability-detail':
      return `/capabilities/${route.section}/${encodeURIComponent(route.capabilityId)}`
    case 'cron-root':
      return '/cron'
    case 'cron-blueprints':
      return '/cron/blueprints'
    case 'cron-job-detail':
      return `/cron/${encodeURIComponent(route.jobId)}`
    case 'cron-job-editor':
      return route.jobId ? `/cron/${encodeURIComponent(route.jobId)}/edit` : '/cron/new'
    case 'settings-root':
      return '/settings'
    case 'settings-category':
      return `/settings/${route.category}`
    case 'settings-administration':
      return `/settings/${route.page}`
  }
}

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

export interface ScreenPath {
  stack: MobileRoute[]
  tab: MobileTab
}

/** Parse an app-screen path into its tab and URL-derived stack. Returns null
 *  for session deep links (the coordinator owns those), unknown namespaces,
 *  and malformed segments — the caller decides what an unknown path means. */
export function navigationFromPath(pathname: string): ScreenPath | null {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (!raw) continue
    const decoded = decodeSegment(raw)
    if (!decoded) return null
    segments.push(decoded)
  }

  if (segments.length === 0) return { stack: [ROOT_ROUTES.roster], tab: 'roster' }
  const [head, second, third] = segments

  if (head === 'group') {
    if (segments.length !== 2 || !second) return null
    return { stack: [ROOT_ROUTES.roster, { roomId: second, tab: 'roster', type: 'group-room' }], tab: 'roster' }
  }

  if (head === 'sessions' && segments.length === 1) return { stack: [ROOT_ROUTES.sessions], tab: 'sessions' }

  if (head === 'capabilities') {
    if (segments.length === 1) return { stack: [ROOT_ROUTES.capabilities], tab: 'capabilities' }
    if (segments.length > 3 || !isCapabilitySection(second)) return null
    const sectionRoute: MobileRoute = { section: second, tab: 'capabilities', type: 'capabilities-section' }
    if (segments.length === 2) return { stack: [ROOT_ROUTES.capabilities, sectionRoute], tab: 'capabilities' }
    if (!third) return null
    return {
      stack: [ROOT_ROUTES.capabilities, sectionRoute, { capabilityId: third, section: second, tab: 'capabilities', type: 'capability-detail' }],
      tab: 'capabilities'
    }
  }

  if (head === 'cron') {
    if (segments.length === 1) return { stack: [ROOT_ROUTES.cron], tab: 'cron' }
    if (second === 'blueprints' && segments.length === 2) {
      return { stack: [ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-blueprints' }], tab: 'cron' }
    }
    if (second === 'new' && segments.length === 2) {
      return { stack: [ROOT_ROUTES.cron, { tab: 'cron', type: 'cron-job-editor' }], tab: 'cron' }
    }
    if (segments.length > 3 || !second || second === 'blueprints' || second === 'new') return null
    const detailRoute: MobileRoute = { jobId: second, tab: 'cron', type: 'cron-job-detail' }
    if (segments.length === 2) return { stack: [ROOT_ROUTES.cron, detailRoute], tab: 'cron' }
    if (third !== 'edit') return null
    return { stack: [ROOT_ROUTES.cron, detailRoute, { jobId: second, tab: 'cron', type: 'cron-job-editor' }], tab: 'cron' }
  }

  if (head === 'settings') {
    if (segments.length === 1) return { stack: [ROOT_ROUTES.settings], tab: 'settings' }
    if (segments.length > 2) return null
    if (isSettingsCategory(second)) {
      return { stack: [ROOT_ROUTES.settings, { category: second, tab: 'settings', type: 'settings-category' }], tab: 'settings' }
    }
    if (isSettingsAdminPage(second)) {
      return { stack: [ROOT_ROUTES.settings, { page: second, tab: 'settings', type: 'settings-administration' }], tab: 'settings' }
    }
    return null
  }

  return null
}

function isCapabilitySection(value: string | undefined): value is CapabilitySection {
  return (CAPABILITY_SECTIONS as readonly string[]).includes(value ?? '')
}

function isSettingsCategory(value: string | undefined): value is SettingsCategory {
  return (SETTINGS_CATEGORIES as readonly string[]).includes(value ?? '')
}

function isSettingsAdminPage(value: string | undefined): value is SettingsAdministrationPage {
  return (SETTINGS_ADMINISTRATION_PAGES as readonly string[]).includes(value ?? '')
}