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
 * Parse a client screen URL supplied at startup. Once the app is running,
 * route changes stay in memory and are not mirrored back into the address bar.
 * Session URLs remain owned by the deep-link coordinator.
 */
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

/** Parse a startup screen path into its tab and in-memory route stack. */
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