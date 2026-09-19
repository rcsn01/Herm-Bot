import { atom } from 'nanostores'

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
import { $navigation, applyPathState, popRoute, pushRoute, resetRoutes, resetTabRoutes, setTab } from './navigation-store'

export type WorkspaceDestination = 'sessions' | 'cron' | 'capabilities' | 'model'

export type BotConfigurationDestination = 'capabilities' | 'cron' | 'model'

/** Dismiss intents emitted by the sessions menu (moved verbatim from
 *  use-navigation-page-controller.ts). */
export type WorkspaceMenuIntent =
  | { type: 'close' }
  | { type: 'model' }
  | { type: 'tab'; tab: MobileTab }

// ── Policy state + dispatch verbs ────────────────────────────────────────────
// The core owns route policy: the menu latch, menu-origin capture, the
// return-origin stack, and every dispatch decision (menu open/dismiss,
// destination taps, the back tree, chat landing). The route-stack store
// (navigation-store.ts) stays the engine — these verbs are its only sanctioned
// callers. The React entry (use-workspace-navigation.ts) is a thin adapter,
// not policy. This file must stay DOM-free: pwa/policy.ts → pwa/sw.ts pulls it
// into the service-worker bundle (guard-tested), so the import set stays
// ./routes + ./navigation-store + nanostores ONLY.

/** Menu latch + menu-origin capture + return-origin stack. Written only by
 *  the verbs below; readable for tests. */
export interface WorkspacePolicyState {
  menuOpen: boolean
  menuOrigin: MobileTab | null
  menuOriginStack: MobileRoute[] | null
  returnOrigin: MobileTab | null
  returnStack: MobileRoute[] | null
}

export const $workspacePolicy = atom<WorkspacePolicyState>({
  menuOpen: false,
  menuOrigin: null,
  menuOriginStack: null,
  returnOrigin: null,
  returnStack: null
})

/** Test/setup verb, symmetric with resetNavigation. */
export function resetWorkspacePolicy(): void {
  $workspacePolicy.set({ menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
}

/** Scope teardown: route stacks AND menu/return policy together (Δ2). */
export function resetWorkspace(): void {
  resetRoutes()
  resetWorkspacePolicy()
}

/** Where a destination's screen back returns when its stack is already at root.
 *  Menu-entered destinations fall back to the profile surface ('sessions');
 *  the roster-entered surfaces and the header fall to the roster. */
export const WORKSPACE_BACK_FALLBACKS: { readonly [Tab in MobileTab]: MobileTab } = {
  roster: 'roster',
  capabilities: 'sessions',
  cron: 'sessions',
  settings: 'roster',
  sessions: 'roster'
}

/** Decoded read for render data (app root, dismissForeground, back internals). */
export function groupIdFromRoute(route: MobileRoute): string | null {
  return route.tab === 'roster' && route.type === 'group-room' ? route.roomId : null
}

// Private helpers — ported verbatim from use-workspace-navigation.ts with atom
// reads/writes replacing refs; the old public hook methods became
// module-internal because their only remaining callers are the verbs below.

function openDestination(tab: MobileTab): void {
  resetTabRoutes(tab)
  setTab(tab)
}

/** model open, shared by both entry paths: setTab first, then the
 *  top-of-stack model check, then reset + push. */
function openModelSettings(): void {
  setTab('settings')
  const current = $navigation.get().stacks.settings.at(-1)
  if (current?.type === 'settings-category' && current.category === 'model') return
  resetTabRoutes('settings')
  pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })
}

function clearReturnPair(): void {
  $workspacePolicy.set({ ...$workspacePolicy.get(), returnOrigin: null, returnStack: null })
}

function exitToReturnOrigin(fallback: MobileTab = 'roster'): void {
  const policy = $workspacePolicy.get()
  const destination = policy.returnOrigin ?? fallback
  const returnStack = policy.returnStack
  const reopenMenu = policy.returnOrigin !== null && returnStack !== null
  $workspacePolicy.set({ ...policy, returnOrigin: null, returnStack: null })
  if (returnStack) applyPathState(destination, returnStack)
  else setTab(destination)
  if (reopenMenu) openMenu()
}

function backOr(tab: MobileTab, fallback: () => void): void {
  if (popRoute(tab) === undefined) fallback()
}

function closeToRoster(): void {
  clearReturnPair()
  setTab('roster')
}

/** Open the sessions menu: capture (activeTab, copy of its stack) first, then
 *  latch if closed — capture-first order preserved; idempotent (open while
 *  open recaptures the origin, exactly as today). */
export function openMenu(): void {
  const navigation = $navigation.get()
  const menuOrigin = navigation.activeTab
  const menuOriginStack = [...navigation.stacks[menuOrigin]] as MobileRoute[]
  const policy = $workspacePolicy.get()
  if (policy.menuOpen) {
    $workspacePolicy.set({ ...policy, menuOrigin, menuOriginStack })
    return
  }
  $workspacePolicy.set({ ...policy, menuOpen: true, menuOrigin, menuOriginStack })
}

/** Resolve a sessions-menu dismiss intent (default {type:'close'}). Closed →
 *  no-op. close → close only. tab t → origin===t ? close only : stash pair +
 *  resetTabRoutes(t) + setTab(t). model → origin already on settings-model ?
 *  close only : stash + openModelSettings(). The menu-origin capture clears
 *  as a pair with the latch. */
export function dismissMenu(intent: WorkspaceMenuIntent = { type: 'close' }): void {
  const policy = $workspacePolicy.get()
  if (!policy.menuOpen) return
  const origin = policy.menuOrigin
  const originStack = policy.menuOriginStack
  $workspacePolicy.set({ ...policy, menuOpen: false, menuOrigin: null, menuOriginStack: null })
  if (intent.type === 'tab') {
    if (origin === intent.tab) return
    $workspacePolicy.set({ ...$workspacePolicy.get(), returnOrigin: origin, returnStack: originStack })
    openDestination(intent.tab)
  } else if (intent.type === 'model') {
    const originRoute = originStack?.at(-1)
    if (origin === 'settings' && originRoute?.type === 'settings-category' && originRoute.category === 'model') return
    $workspacePolicy.set({ ...$workspacePolicy.get(), returnOrigin: origin, returnStack: originStack })
    openModelSettings()
  }
}

/** Bottom-nav destination tap (menu closed). 'sessions' → openMenu();
 *  'model' → openModelSettings() (NO stash — bottom-nav path); else
 *  resetTabRoutes(tab) + setTab(tab). */
export function openWorkspaceDestination(destination: WorkspaceDestination): void {
  if (destination === 'sessions') {
    openMenu()
    return
  }
  if (destination === 'model') openModelSettings()
  else openDestination(destination)
}

/** Push a group-room route onto the roster stack (roster tap + created-group). */
export function openGroupRoom(roomId: string): void {
  pushRoute('roster', { roomId, tab: 'roster', type: 'group-room' })
}

/** Land on the chat surface fresh: clear the return pair, close the menu latch
 *  and drop its captured origin (latch closed ⇒ no capture, as today; no
 *  stash, no intent side effects), setTab('sessions'). One verb for roster
 *  agent entry, cron run → session, and deep-link landing (Δ1). */
export function openChatSurface(): void {
  $workspacePolicy.set({ ...$workspacePolicy.get(), menuOpen: false, menuOrigin: null, menuOriginStack: null, returnOrigin: null, returnStack: null })
  setTab('sessions')
}

/** Header gear: clear the return pair, resetTabRoutes('settings'), setTab('settings'). */
export function openSettings(): void {
  clearReturnPair()
  resetTabRoutes('settings')
  setTab('settings')
}

/** Committed foreground swipe: group-room route → resetTabRoutes('roster');
 *  sessions-or-group → setTab('roster'); else no-op (totality). Does NOT clear
 *  the return pair (byte-for-byte with today's closure). */
export function dismissForeground(): void {
  const navigation = $navigation.get()
  const stack = navigation.stacks[navigation.activeTab] as MobileRoute[]
  const active = stack.at(-1)
  const groupId = active ? groupIdFromRoute(active) : null
  if (groupId) resetTabRoutes('roster')
  if (navigation.activeTab === 'sessions' || groupId) setTab('roster')
}

/** The whole back tree, one owner:
 *  ① group-room route → popRoute('roster'); at root → close-to-roster (clear
 *     pair + setTab('roster'))
 *  ② tab sessions → close-to-roster
 *  ③ settings ∧ settings-category ∧ 'model' ∧ returnOrigin → consume the pair
 *     (applyPathState(origin, returnStack) else setTab(origin)) and reopen the
 *     menu — the reopen recaptures the restored surface as the menu origin
 *  ④ else popRoute(activeTab); at root → exitToReturnOrigin(fallback) where
 *     fallback = source === 'header' ? 'roster' : WORKSPACE_BACK_FALLBACKS[tab] */
export function back(source: 'header' | 'screen'): void {
  const navigation = $navigation.get()
  const stack = navigation.stacks[navigation.activeTab] as MobileRoute[]
  const active = stack.at(-1)
  const groupId = active ? groupIdFromRoute(active) : null
  if (groupId) {
    backOr('roster', closeToRoster)
    return
  }
  if (navigation.activeTab === 'sessions') {
    closeToRoster()
    return
  }
  if (
    navigation.activeTab === 'settings' &&
    active?.type === 'settings-category' &&
    active.category === 'model' &&
    $workspacePolicy.get().returnOrigin
  ) {
    exitToReturnOrigin()
    return
  }
  backOr(navigation.activeTab, () => exitToReturnOrigin(source === 'header' ? 'roster' : WORKSPACE_BACK_FALLBACKS[navigation.activeTab]))
}

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