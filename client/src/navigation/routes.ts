export const MOBILE_TABS = ['capabilities', 'cron', 'settings', 'sessions'] as const

export type MobileTab = (typeof MOBILE_TABS)[number]

export type CapabilitySection = 'mcp' | 'skills' | 'tools'

export interface SessionsRootRoute {
  type: 'sessions-root'
  tab: 'sessions'
}

export interface CapabilitiesRootRoute {
  type: 'capabilities-root'
  tab: 'capabilities'
}

export interface CapabilitiesSectionRoute {
  type: 'capabilities-section'
  tab: 'capabilities'
  section: CapabilitySection
}

export interface CapabilityDetailRoute {
  type: 'capability-detail'
  tab: 'capabilities'
  section: CapabilitySection
  capabilityId: string
}

export type CapabilitiesRoute = CapabilitiesRootRoute | CapabilitiesSectionRoute | CapabilityDetailRoute

export interface CronRootRoute {
  type: 'cron-root'
  tab: 'cron'
}

export interface CronJobDetailRoute {
  type: 'cron-job-detail'
  tab: 'cron'
  jobId: string
}

export interface CronJobEditorRoute {
  type: 'cron-job-editor'
  tab: 'cron'
  jobId?: string
}

export interface CronBlueprintsRoute {
  type: 'cron-blueprints'
  tab: 'cron'
}

export type CronRoute = CronRootRoute | CronJobDetailRoute | CronJobEditorRoute | CronBlueprintsRoute

export type SettingsCategory =
  | 'about'
  | 'advanced'
  | 'appearance'
  | 'browser'
  | 'chat'
  | 'memory'
  | 'model'
  | 'notifications'
  | 'keyboard-shortcuts'
  | 'safety'
  | 'voice'
  | 'workspace'

export type SettingsAdministrationPage =
  | 'agents'
  | 'archived-chats'
  | 'billing'
  | 'gateway'
  | 'learning'
  | 'logs'
  | 'messaging'
  | 'pairing'
  | 'plugins'
  | 'profiles'
  | 'projects'
  | 'providers'
  | 'system'
  | 'tools-keys'
  | 'usage'
  | 'webhooks'

export interface SettingsRootRoute {
  type: 'settings-root'
  tab: 'settings'
}

export interface SettingsCategoryRoute {
  type: 'settings-category'
  tab: 'settings'
  category: SettingsCategory
}

export interface SettingsAdministrationRoute {
  type: 'settings-administration'
  tab: 'settings'
  page: SettingsAdministrationPage
}

export type SettingsRoute = SettingsRootRoute | SettingsCategoryRoute | SettingsAdministrationRoute

export interface RoutesByTab {
  capabilities: CapabilitiesRoute
  cron: CronRoute
  settings: SettingsRoute
  sessions: SessionsRootRoute
}

export type MobileRoute = RoutesByTab[MobileTab]
export type RouteForTab<Tab extends MobileTab> = RoutesByTab[Tab]

export const ROOT_ROUTES = {
  capabilities: { type: 'capabilities-root', tab: 'capabilities' },
  cron: { type: 'cron-root', tab: 'cron' },
  settings: { type: 'settings-root', tab: 'settings' },
  sessions: { type: 'sessions-root', tab: 'sessions' }
} as const satisfies { [Tab in MobileTab]: RouteForTab<Tab> }

export function rootRoute<Tab extends MobileTab>(tab: Tab): (typeof ROOT_ROUTES)[Tab] {
  return ROOT_ROUTES[tab]
}
