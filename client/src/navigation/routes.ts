export const MOBILE_TABS = ['sessions', 'capabilities', 'operations', 'more'] as const

export type MobileTab = (typeof MOBILE_TABS)[number]

export interface SessionsRootRoute {
  type: 'sessions-root'
  tab: 'sessions'
}

export interface SessionsChatRoute {
  type: 'sessions-chat'
  tab: 'sessions'
}

export interface CapabilitiesRootRoute {
  type: 'capabilities-root'
  tab: 'capabilities'
}

export interface CapabilityDetailRoute {
  type: 'capability-detail'
  tab: 'capabilities'
  capabilityId: string
  capabilityType: 'computer-use' | 'credential' | 'mcp' | 'memory' | 'model' | 'plugin' | 'provider' | 'skill' | 'tool'
}

export interface OperationsRootRoute {
  type: 'operations-root'
  tab: 'operations'
}

export interface OperationDetailRoute {
  type: 'operation-detail'
  tab: 'operations'
  operationId: string
  operationType: 'agent' | 'cron' | 'messaging' | 'pairing' | 'webhook'
}

export interface MoreRootRoute {
  type: 'more-root'
  tab: 'more'
}

export interface MoreDetailRoute {
  type: 'more-detail'
  tab: 'more'
  page: 'billing' | 'learning' | 'logs' | 'profiles' | 'projects' | 'settings' | 'system' | 'usage'
}

export type SessionsRoute = SessionsRootRoute | SessionsChatRoute
export type CapabilitiesRoute = CapabilitiesRootRoute | CapabilityDetailRoute
export type OperationsRoute = OperationsRootRoute | OperationDetailRoute
export type MoreRoute = MoreRootRoute | MoreDetailRoute

export interface RoutesByTab {
  sessions: SessionsRoute
  capabilities: CapabilitiesRoute
  operations: OperationsRoute
  more: MoreRoute
}

export type MobileRoute = RoutesByTab[MobileTab]
export type RouteForTab<Tab extends MobileTab> = RoutesByTab[Tab]

export const ROOT_ROUTES = {
  sessions: { type: 'sessions-root', tab: 'sessions' },
  capabilities: { type: 'capabilities-root', tab: 'capabilities' },
  operations: { type: 'operations-root', tab: 'operations' },
  more: { type: 'more-root', tab: 'more' }
} as const satisfies { [Tab in MobileTab]: RouteForTab<Tab> }

export function rootRoute<Tab extends MobileTab>(tab: Tab): (typeof ROOT_ROUTES)[Tab] {
  return ROOT_ROUTES[tab]
}
