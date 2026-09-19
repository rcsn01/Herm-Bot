import { useStore } from '@nanostores/react'

import { $activeRoute, $navigation, pushRoute } from '~/navigation/navigation-store'
import type { CapabilitiesRoute, CronRoute, MobileTab, RouteForTab, SettingsRoute } from '~/navigation/routes'
import {
  $workspacePolicy,
  back,
  dismissForeground,
  dismissMenu,
  groupIdFromRoute,
  narrowRoute,
  openChatSurface,
  openGroupRoom,
  openMenu,
  openSettings,
  openWorkspaceDestination,
  workspaceBackLabel,
  workspaceDestinationFor,
  workspaceRouteTitle,
  workspaceTabTitle,
  type BotConfigurationDestination,
  type WorkspaceDestination,
  type WorkspaceMenuIntent
} from '~/navigation/workspace-navigation'

/** React adapter over the DOM-free Workspace navigation core. This file owns
 *  no policy: it binds the policy/navigation stores for rendering, derives the
 *  header model and visibility reads per render, and exposes the core verbs
 *  plus the per-screen api. The core (workspace-navigation.ts) owns the
 *  policy state and dispatch; the store (navigation-store.ts) stays the
 *  engine. */

export type WorkspaceScreenTab = 'capabilities' | 'cron' | 'settings'

export interface WorkspaceScreenApi<Tab extends WorkspaceScreenTab> {
  /** The tab's active route, narrowed; the tab root is the total fallback. */
  route: RouteForTab<Tab>
  /** Core back('screen'): popRoute; at root → exitToReturnOrigin(WORKSPACE_BACK_FALLBACKS[tab]).
   *  Tree branches ①–③ are unreachable here — no group-room or sessions route can be active
   *  under a capabilities/cron/settings api, and ③'s trigger (the model surface with a return
   *  origin) hides ModelsScreen's in-page back — so this description holds for every reachable
   *  state. */
  back(): void
  /** pushRoute(route.tab, route) — a cron screen cannot push a settings route. */
  navigate(route: RouteForTab<Tab>): void
}

export interface WorkspaceSettingsScreenApi extends WorkspaceScreenApi<'settings'> {
  /** ModelsScreen's in-page back: visible only when the model surface was
   *  reached without a sessions-menu return origin. (Absorbs showModelBack.) */
  showModelBack: boolean
}

export interface WorkspaceHeaderModel {
  /** workspaceDestinationFor(activeTab, activeRoute) — null hides the
   *  bot-workspace header AND the bottom nav. */
  destination: BotConfigurationDestination | null
  /** workspaceRouteTitle for bot destinations, else workspaceTabTitle. */
  title: string
  /** workspaceBackLabel(stackNested, destination, returnOrigin !== null). */
  backLabel: 'Back' | 'Back to menu' | 'Back to bots'
}

export interface WorkspaceNavigation {
  // reads
  menuOpen: boolean
  /** Read for labels/tests; written only by the core verbs. */
  returnOrigin: MobileTab | null
  /** activeTab !== 'roster' || group-room route */
  foregroundVisible: boolean
  /** sessions tab || group-room route */
  foregroundDismissible: boolean
  header: WorkspaceHeaderModel
  // sessions menu
  openMenu(): void
  dismissMenu(intent?: WorkspaceMenuIntent): void
  // destinations
  openWorkspaceDestination(destination: WorkspaceDestination): void
  openGroupRoom(roomId: string): void
  // app-root intents
  openChatSurface(): void
  openSettings(): void
  dismissForeground(): void
  /** The header back: == core back('header'). */
  back(): void
  // per-screen injection
  screen(tab: 'settings'): WorkspaceSettingsScreenApi
  screen<Tab extends WorkspaceScreenTab>(tab: Tab): WorkspaceScreenApi<Tab>
}

/** Stable header-back verb: the core back with the header source. */
const backFromHeader = (): void => back('header')

export function useWorkspaceNavigation(): WorkspaceNavigation {
  const policy = useStore($workspacePolicy)
  const navigation = useStore($navigation)
  const activeRoute = useStore($activeRoute)

  const activeTab = navigation.activeTab
  const stackNested = navigation.stacks[activeTab].length > 1
  const groupId = groupIdFromRoute(activeRoute)
  const destination = workspaceDestinationFor(activeTab, activeRoute)

  function screen(tab: 'settings'): WorkspaceSettingsScreenApi
  function screen<Tab extends WorkspaceScreenTab>(tab: Tab): WorkspaceScreenApi<Tab>
  function screen(tab: WorkspaceScreenTab): WorkspaceSettingsScreenApi | WorkspaceScreenApi<'capabilities'> | WorkspaceScreenApi<'cron'> {
    if (tab === 'settings') {
      const settingsApi: WorkspaceSettingsScreenApi = {
        route: narrowRoute('settings', activeRoute),
        back: () => back('screen'),
        navigate: (route: SettingsRoute) => pushRoute('settings', route),
        showModelBack: policy.returnOrigin === null
      }
      return settingsApi
    }
    if (tab === 'cron') {
      const cronApi: WorkspaceScreenApi<'cron'> = {
        route: narrowRoute(tab, activeRoute),
        back: () => back('screen'),
        navigate: (route: CronRoute) => pushRoute('cron', route)
      }
      return cronApi
    }
    const capabilitiesApi: WorkspaceScreenApi<'capabilities'> = {
      route: narrowRoute(tab, activeRoute),
      back: () => back('screen'),
      navigate: (route: CapabilitiesRoute) => pushRoute('capabilities', route)
    }
    return capabilitiesApi
  }

  return {
    menuOpen: policy.menuOpen,
    returnOrigin: policy.returnOrigin,
    foregroundVisible: activeTab !== 'roster' || groupId !== null,
    foregroundDismissible: activeTab === 'sessions' || groupId !== null,
    header: {
      destination,
      title: destination ? workspaceRouteTitle(destination, activeRoute) : workspaceTabTitle(activeTab),
      backLabel: workspaceBackLabel(stackNested, destination, policy.returnOrigin !== null)
    },
    openMenu,
    dismissMenu,
    openWorkspaceDestination,
    openGroupRoom,
    openChatSurface,
    openSettings,
    dismissForeground,
    back: backFromHeader,
    screen
  }
}