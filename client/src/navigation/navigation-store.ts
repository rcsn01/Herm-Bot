import { atom, computed } from 'nanostores'

import { MOBILE_TABS, ROOT_ROUTES } from '~/navigation/routes'
import type { MobileRoute, MobileTab, RouteForTab, RoutesByTab } from '~/navigation/routes'

export type NavigationStacks = { [Tab in MobileTab]: RouteForTab<Tab>[] }

export interface NavigationState {
  activeTab: MobileTab
  stacks: NavigationStacks
}

function initialStacks(): NavigationStacks {
  return {
    sessions: [ROOT_ROUTES.sessions],
    capabilities: [ROOT_ROUTES.capabilities],
    operations: [ROOT_ROUTES.operations],
    more: [ROOT_ROUTES.more]
  }
}

export function initialNavigationState(activeTab: MobileTab = 'sessions'): NavigationState {
  return { activeTab, stacks: initialStacks() }
}

export const $navigation = atom<NavigationState>(initialNavigationState())
export const $activeTab = computed($navigation, state => state.activeTab)
export const $activeRoute = computed($navigation, state => {
  const stack = state.stacks[state.activeTab] as MobileRoute[]
  return stack[stack.length - 1]
})

export function setTab(tab: MobileTab): void {
  const state = $navigation.get()
  if (state.activeTab !== tab) $navigation.set({ ...state, activeTab: tab })
}

/** Push onto a tab's stack without disturbing any other tab or selecting it. */
export function pushRoute<Tab extends MobileTab>(tab: Tab, route: RoutesByTab[Tab]): void {
  if (route.tab !== tab) throw new Error(`Cannot push a ${route.tab} route onto the ${tab} stack`)
  const state = $navigation.get()
  $navigation.set({
    ...state,
    stacks: { ...state.stacks, [tab]: [...state.stacks[tab], route] } as NavigationStacks
  })
}

/** Pop a tab's stack. Its root is permanent, so popping at root is a no-op. */
export function popRoute(tab: MobileTab = $navigation.get().activeTab): MobileRoute | undefined {
  const state = $navigation.get()
  const stack = state.stacks[tab] as MobileRoute[]
  if (stack.length === 1) return undefined
  const popped = stack[stack.length - 1]
  $navigation.set({
    ...state,
    stacks: { ...state.stacks, [tab]: stack.slice(0, -1) } as NavigationStacks
  })
  return popped
}

/** Clear detail routes while retaining the selected tab and every tab root. */
export function resetRoutes(): void {
  const { activeTab } = $navigation.get()
  $navigation.set(initialNavigationState(activeTab))
}

/** Reset one stack while preserving the selected tab and all other stacks. */
export function resetTabRoutes(tab: MobileTab): void {
  const state = $navigation.get()
  $navigation.set({
    ...state,
    stacks: { ...state.stacks, [tab]: [ROOT_ROUTES[tab]] } as NavigationStacks
  })
}

export function resetNavigation(activeTab: MobileTab = 'sessions'): void {
  $navigation.set(initialNavigationState(activeTab))
}

export function isMobileTab(value: string): value is MobileTab {
  return (MOBILE_TABS as readonly string[]).includes(value)
}
