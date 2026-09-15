import {
  CAPABILITY_SECTIONS,
  ROOT_ROUTES,
  SETTINGS_ADMINISTRATION_PAGES,
  SETTINGS_CATEGORIES,
  type CapabilitySection,
  type MobileRoute,
  type MobileTab,
  type RouteForTab,
  type SettingsAdministrationPage,
  type SettingsCategory
} from './routes'
import { applyPathState } from './navigation-store'

export type WorkspaceDestination = 'sessions' | 'cron' | 'capabilities' | 'model'

export type BotConfigurationDestination = 'capabilities' | 'cron' | 'model'

/** Dismiss intents emitted by the sessions menu (moved verbatim from
 *  use-navigation-page-controller.ts). */
export type WorkspaceMenuIntent =
  | { type: 'close' }
  | { type: 'model' }
  | { type: 'tab'; tab: MobileTab }

/** Single source for the bottom-nav destinations and their labels, in the
 *  current order (sessions, cron, capabilities, model — e2e asserts DOM
 *  order). 'model' is a pseudo-destination: it opens the settings-category
 *  route, not a tab. bot-workspace-navigation maps ids to icons locally.
 *  Header titles stay in the two absorbed title tables (label and title
 *  coincide for every destination today, so no second field here). */
export const WORKSPACE_DESTINATIONS = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'cron', label: 'Automations' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'model', label: 'Models' }
] as const satisfies readonly { id: WorkspaceDestination; label: string }[]

const DESTINATION_TITLES: { [Tab in MobileTab]: string } = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  roster: 'Hermes',
  settings: 'Settings',
  sessions: 'Sessions'
}

const BOT_CONFIGURATION_TITLES: { [Destination in BotConfigurationDestination]: string } = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  model: 'Models'
}

/** Plain destination header title (DESTINATION_TITLES absorbed). */
export function workspaceTabTitle(tab: MobileTab): string {
  return DESTINATION_TITLES[tab]
}

/** Bot-configuration header title: detail-route titles for cron/capability
 *  routes, else the destination title (BOT_CONFIGURATION_TITLES +
 *  botWorkspaceRouteTitle absorbed). */
export function workspaceRouteTitle(destination: BotConfigurationDestination, route: MobileRoute): string {
  if (route.type === 'cron-job-detail') return 'Job details'
  if (route.type === 'cron-job-editor') return route.jobId ? 'Edit job' : 'New job'
  if (route.type === 'cron-blueprints') return 'Blueprints'
  if (route.type === 'capabilities-section') return route.section === 'mcp' ? 'MCP' : route.section === 'skills' ? 'Skills' : 'Tools'
  if (route.type === 'capability-detail') {
    if (route.capabilityId === 'skills-hub') return 'Skill hub'
    if (route.capabilityId === 'mcp-catalog') return 'MCP catalog'
    if (route.capabilityId === 'mcp:new') return 'Add server'
    if (route.capabilityId.startsWith('skill:')) return route.capabilityId.slice(6) || 'Skill'
    if (route.capabilityId.startsWith('toolset:')) return route.capabilityId.slice(8) || 'Toolset'
    if (route.capabilityId.startsWith('mcp:')) return route.capabilityId.slice(4) || 'MCP server'
  }
  return BOT_CONFIGURATION_TITLES[destination]
}

/** Which bot-configuration destination the active surface shows, or null
 *  (activeBotConfigurationDestination absorbed, incl. the 'model' rule). */
export function workspaceDestinationFor(tab: MobileTab, route: MobileRoute): BotConfigurationDestination | null {
  if (tab === 'capabilities' || tab === 'cron') return tab
  if (tab === 'settings' && route.type === 'settings-category' && route.category === 'model') return 'model'
  return null
}

/** Narrow the active-route union to a tab's route type; the tab root is the
 *  fallback. Total — never throws (replaces the three routeFor* helpers). */
export function narrowRoute<Tab extends MobileTab>(tab: Tab, route: MobileRoute): RouteForTab<Tab> {
  return (route.tab === tab ? route : ROOT_ROUTES[tab]) as RouteForTab<Tab>
}

/** The sessions menu's dismiss intent for a destination tap
 *  (model → {type:'model'}, else {type:'tab', tab}). 'sessions' callers
 *  guard it as a no-op themselves, exactly as today. */
export function workspaceMenuIntent(destination: WorkspaceDestination): WorkspaceMenuIntent {
  return destination === 'model' ? { type: 'model' } : { type: 'tab', tab: destination }
}

/** Back-label policy: nested detail wins — except the model surface with a
 *  return origin, which reads 'Back to menu' (today's modelReturnsToSurface
 *  suppression) — then menu-origin return, then roster. Pass surface =
 *  workspaceDestinationFor(tab, route). */
export function workspaceBackLabel(nested: boolean, surface: BotConfigurationDestination | null, hasReturnOrigin: boolean): 'Back' | 'Back to menu' | 'Back to bots' {
  if (nested && !(surface === 'model' && hasReturnOrigin)) return 'Back'
  return hasReturnOrigin ? 'Back to menu' : 'Back to bots'
}

interface ScreenUrlHead {
  head: string
  parsable: boolean
  served: boolean
  legacy?: boolean
}

/** One vocabulary for the startup URL parser and the service-worker
 *  screen-path allowlist. The legacy heads are served by the offline shell
 *  but rejected by the parser — preserved byte-for-byte, pinned by
 *  pwa/policy.test.ts. */
export const SCREEN_URL_HEADS: readonly ScreenUrlHead[] = [
  { head: 'bot', parsable: false, served: true, legacy: true },
  { head: 'group', parsable: true, served: true },
  { head: 'sessions', parsable: true, served: true },
  { head: 'capabilities', parsable: true, served: true },
  { head: 'cron', parsable: true, served: true },
  { head: 'settings', parsable: true, served: true },
  { head: 'navigation', parsable: false, served: true, legacy: true }
]

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

interface ScreenPath {
  stack: MobileRoute[]
  tab: MobileTab
}

/** Parse a startup screen path into its tab and in-memory route stack (absorbed
 *  from screen-url.ts, private). */
function navigationFromPath(pathname: string): ScreenPath | null {
  const segments: string[] = []
  for (const raw of pathname.split('/')) {
    if (!raw) continue
    const decoded = decodeSegment(raw)
    if (!decoded) return null
    segments.push(decoded)
  }

  if (segments.length === 0) return { stack: [ROOT_ROUTES.roster], tab: 'roster' }
  const [head, second, third] = segments

  if (!SCREEN_URL_HEADS.some(entry => entry.parsable && entry.head === head)) return null

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

/** Cold start only: parse a screen path and apply it to the in-memory router.
 *  Returns false — store untouched — for unknown, malformed, and /session/*
 *  paths (those belong to the DeepLinkCoordinator). '/' parses to the roster
 *  root and applies, like today's restoreInitialNavigation. Call once per
 *  cold start, before any user navigation. (Absorbs initial-navigation.ts.) */
export function restoreWorkspacePath(pathname: string): boolean {
  const parsed = navigationFromPath(pathname)
  if (!parsed) return false
  applyPathState(parsed.tab, parsed.stack)
  return true
}

/** Service-worker screen-path allowlist. Derived from the same head table the
 *  parser uses: parseable heads plus the legacy served-only heads {bot,
 *  navigation}. First-segment prefix semantics, exactly the regex it replaces
 *  (`^/head(?:/|$)` per served head), NOT parse success: malformed subpaths
 *  under a served head still serve the shell (e.g. '/group/a/b',
 *  '/sessions/x'), and '/session/…' stays excluded because the head 'session'
 *  is not in the table. (Absorbs pwa/policy.ts's private regex.) */
export function isAppShellScreenPath(pathname: string): boolean {
  return SCREEN_URL_HEADS.some(({ head, served }) => {
    if (!served) return false
    const prefix = `/${head}`
    return pathname === prefix || pathname.startsWith(`${prefix}/`)
  })
}