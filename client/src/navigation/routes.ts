export const MOBILE_TABS = ['chat', 'sessions', 'capabilities', 'operations', 'more'] as const

export type MobileTab = (typeof MOBILE_TABS)[number]

export interface ChatRootRoute {
  type: 'chat-root'
  tab: 'chat'
}

export interface ChatThreadRoute {
  type: 'chat-thread'
  tab: 'chat'
  sessionId: string
}

export interface SessionsRootRoute {
  type: 'sessions-root'
  tab: 'sessions'
}

export interface SessionDetailRoute {
  type: 'session-detail'
  tab: 'sessions'
  sessionId: string
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

export type ChatRoute = ChatRootRoute | ChatThreadRoute
export type SessionsRoute = SessionsRootRoute | SessionDetailRoute
export type CapabilitiesRoute = CapabilitiesRootRoute | CapabilityDetailRoute
export type OperationsRoute = OperationsRootRoute | OperationDetailRoute
export type MoreRoute = MoreRootRoute | MoreDetailRoute

export interface RoutesByTab {
  chat: ChatRoute
  sessions: SessionsRoute
  capabilities: CapabilitiesRoute
  operations: OperationsRoute
  more: MoreRoute
}

export type MobileRoute = RoutesByTab[MobileTab]
export type RouteForTab<Tab extends MobileTab> = RoutesByTab[Tab]

export const ROOT_ROUTES = {
  chat: { type: 'chat-root', tab: 'chat' },
  sessions: { type: 'sessions-root', tab: 'sessions' },
  capabilities: { type: 'capabilities-root', tab: 'capabilities' },
  operations: { type: 'operations-root', tab: 'operations' },
  more: { type: 'more-root', tab: 'more' }
} as const satisfies { [Tab in MobileTab]: RouteForTab<Tab> }

export function rootRoute<Tab extends MobileTab>(tab: Tab): (typeof ROOT_ROUTES)[Tab] {
  return ROOT_ROUTES[tab]
}
