import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconMenu2, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { BotWorkspaceNavigation, type BotWorkspaceDestination } from '~/components/bot-workspace-navigation'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SessionsMenu } from '~/components/sessions-menu'
import { displayNameFor } from '~/features/agents/agent-labels'
import { GroupChatScreen } from '~/features/groups/group-screen'
import { $groups } from '~/features/groups/groups-store'
import { applyTheme } from '~/features/settings/settings-screen'
import { RosterScreen } from '~/features/agents/roster-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import type { CapabilitiesRoute, CronRoute, MobileRoute, MobileTab, SettingsRoute } from '~/navigation/routes'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator, parseHermesDeepLink } from '~/navigation/deep-links'
import { restoreInitialNavigation } from '~/navigation/initial-navigation'
import { $activeRoute, $navigation, applyPathState, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
import { useNavigationPageController } from '~/navigation/use-navigation-page-controller'
import { ROOT_ROUTES } from '~/navigation/routes'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { $chat } from '~/state/conversation'
import { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences, $profileSwitching } from '~/state/store'

const controller = new GatewayController()
const deepLinks = new DeepLinkCoordinator(controller)

const DESTINATION_TITLES = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  roster: 'Hermes',
  settings: 'Settings',
  sessions: 'Sessions'
} as const

const BOT_CONFIGURATION_TITLES = {
  capabilities: 'Capabilities',
  cron: 'Automations',
  model: 'Models'
} as const

export function App() {
  const connection = useStore($connection)
  const preferences = useStore($preferences)
  const profileSwitching = useStore($profileSwitching)
  const navigation = useStore($navigation)
  const activeRoute = useStore($activeRoute)
  const activeGroupId = routeForGroupRoom(activeRoute)
  const groups = useStore($groups)
  const activeGroup = activeGroupId ? groups.find(room => room.key === activeGroupId) ?? null : null
  const chat = useStore($chat)
  const [refreshing, setRefreshing] = useState(false)
  const [rosterQuery, setRosterQuery] = useState('')
  const [returnTab, setReturnTab] = useState<MobileTab | null>(null)
  const initialNavigationRestoredRef = useRef(false)
  const menuOriginRef = useRef<MobileTab | null>(null)
  const menuOriginStackRef = useRef<MobileRoute[] | null>(null)
  const returnStackRef = useRef<MobileRoute[] | null>(null)
  const navigationPage = useNavigationPageController({
    onDismissed: intent => {
      const origin = menuOriginRef.current
      const originStack = menuOriginStackRef.current
      menuOriginRef.current = null
      menuOriginStackRef.current = null
      if (intent.type === 'tab') {
        if (origin === intent.tab) return
        setReturnTab(origin)
        returnStackRef.current = originStack
        openDestination(intent.tab)
      } else if (intent.type === 'model') {
        const originRoute = originStack?.at(-1)
        if (origin === 'settings' && originRoute?.type === 'settings-category' && originRoute.category === 'model') return
        setReturnTab(origin)
        returnStackRef.current = originStack
        openModelSettings()
      }
    }
  })
  const navigationPageOpen = navigationPage.isOpen

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  // A screen URL is an optional cold-start input only. Once the app is
  // running, route state stays in memory and never grows browser history.
  useEffect(() => {
    if (initialNavigationRestoredRef.current) return
    initialNavigationRestoredRef.current = true
    const pathname = window.location.pathname
    restoreInitialNavigation(pathname)
    if (pathname !== '/' && !parseHermesDeepLink(window.location.href)) {
      history.replaceState(null, '', '/')
    }
  }, [])

  useEffect(() => {
    void controller.initialize()
    return () => controller.dispose()
  }, [])

  useEffect(() => observeHermesDeepLinks(rawURL => deepLinks.accept(rawURL)), [])
  useEffect(() => {
    deepLinks.setReady(connection.phase === 'connected')
    return () => deepLinks.setReady(false)
  }, [connection.phase])

  const reconnecting = connection.phase === 'reconnecting' && Boolean(chat.runtimeSessionId)
  // The sessions menu belongs to profile surfaces only; the main screen is
  // the roster, so it has no menu button or sessions menu.
  const inProfile = navigation.activeTab !== 'roster'

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark letter">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect().catch(() => undefined)}>Check again</Button></main>
  }
  // The full-screen takeover is for cold boot and lost transports. A roster
  // tap (a profile switch) renders the destination shell in place instead —
  // the chat screen shows its own inline connecting state.
  const switchingConnect = connection.phase === 'connecting' && profileSwitching
  if (connection.phase === 'connecting' && !profileSwitching || (connection.phase === 'reconnecting' && !reconnecting)) {
    return <main aria-label="Connecting to Hermes" className="blocking-screen startup-screen"><BrandMark small /><p role="status">Connecting…</p></main>
  }
  if (connection.phase !== 'connected' && !reconnecting && !switchingConnect) return <ConnectScreen controller={controller} />

  const refresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([controller.conversation.reconcileHistory(), controller.refreshSessions()])
    setRefreshing(false)
  }
  const clearMenuReturn = () => {
    setReturnTab(null)
    returnStackRef.current = null
  }
  const openAgent = (profile: null | string) => {
    // Enter the destination first; the wire work (profile switch, session
    // resume) streams into the already-visible chat shell.
    clearMenuReturn()
    setTab('sessions')
    void controller.openProfile(profile)
  }
  /** In-app back pops the active in-memory route stack; at its root the
   *  caller's destination fallback runs instead. */
  const goBackOr = (fallback: () => void) => {
    if (popRoute(navigation.activeTab) === undefined) fallback()
  }
  const exitDestination = (fallback: MobileTab = 'roster') => {
    const destination = returnTab ?? fallback
    const returnStack = returnStackRef.current
    const reopenMenu = returnTab !== null && returnStack !== null
    clearMenuReturn()
    if (returnStack) applyPathState(destination, returnStack)
    else setTab(destination)
    if (reopenMenu) {
      menuOriginRef.current = destination
      menuOriginStackRef.current = returnStack
      navigationPage.openNavigationPage()
    }
  }
  const backToRoster = () => {
    clearMenuReturn()
    setTab('roster')
  }
  const openSettingsFrom = () => {
    clearMenuReturn()
    resetTabRoutes('settings')
    setTab('settings')
  }
  const openNavigationPage = () => {
    menuOriginRef.current = navigation.activeTab
    menuOriginStackRef.current = [...navigation.stacks[navigation.activeTab]] as MobileRoute[]
    navigationPage.openNavigationPage()
  }
  const selectBotWorkspaceDestination = (destination: BotWorkspaceDestination) => {
    if (destination === 'sessions') {
      openNavigationPage()
      return
    }
    if (destination === 'model') openModelSettings()
    else openDestination(destination)
  }
  const nestedRoute = navigation.stacks[navigation.activeTab].length > 1
  const activeBotConfiguration = activeBotConfigurationDestination(navigation.activeTab, activeRoute)
  const modelReturnsToSurface = navigation.activeTab === 'settings' && activeRoute.type === 'settings-category' && activeRoute.category === 'model' && returnTab
  const backDestinationLabel = nestedRoute && !modelReturnsToSurface
    ? 'Back'
    : returnTab
      ? 'Back to menu'
      : 'Back to bots'
  const botName = displayNameFor({ name: preferences.profile || 'default' })
  const headerTitle = DESTINATION_TITLES[navigation.activeTab]
  /** Profile surfaces lead with the bot's identity. Chat shows the current
   *  session beneath it; configuration pages show their workspace section. */
  const headerSubtitle = navigation.activeTab === 'sessions'
    ? (chat.info as { title?: string } | null)?.title || 'New conversation'
    : activeBotConfiguration
      ? BOT_CONFIGURATION_TITLES[activeBotConfiguration]
      : null
  const foregroundVisible = navigation.activeTab !== 'roster' || Boolean(activeGroupId)
  const foregroundDismissible = navigation.activeTab === 'sessions' || Boolean(activeGroupId)
  const backFromForeground = () => {
    if (activeGroupId) {
      if (popRoute('roster') === undefined) backToRoster()
      return
    }
    if (navigation.activeTab === 'sessions') {
      backToRoster()
      return
    }
    if (navigation.activeTab === 'settings' && activeRoute.type === 'settings-category' && activeRoute.category === 'model' && returnTab) {
      exitDestination()
      return
    }
    if (popRoute(navigation.activeTab) === undefined) exitDestination()
  }
  const rosterHeader = (
    <header className="app-header">
      <div className="header-search">
        <IconSearch aria-hidden size={17} />
        <Input aria-label="Search bots" onChange={event => setRosterQuery(event.target.value)} placeholder="Search bots" type="search" value={rosterQuery} />
      </div>
      <Button aria-label="Open settings" className="header-gear-button" onClick={openSettingsFrom} variant="ghost"><IconSettings className="size-6" /></Button>
    </header>
  )
  const foregroundHeader = foregroundVisible ? (
    <header className="app-header">
      {activeGroupId ? (
        <>
          <Button aria-label="Back to bots" className="header-back-button" onClick={backFromForeground} variant="ghost"><IconChevronLeft className="size-6" /></Button>
          <div aria-level={1} className="header-title" role="heading"><div><strong>{activeGroup?.name ?? 'Group chat'}</strong></div></div>
        </>
      ) : (
        <Button aria-label={backDestinationLabel} className="header-back-button" onClick={backFromForeground} variant="ghost"><IconChevronLeft className="size-6" /></Button>
      )}
      {navigation.activeTab === 'sessions' || activeBotConfiguration ? (
        <div className="header-bot-button">
          <div><strong>{botName}</strong><small>{reconnecting && navigation.activeTab === 'sessions' ? 'Reconnecting…' : headerSubtitle}</small></div>
        </div>
      ) : inProfile ? (
        <div aria-level={1} className="header-title" role="heading"><div><strong>{headerTitle}</strong></div></div>
      ) : null}
      {inProfile && (
        <Button aria-controls="sessions-menu" aria-expanded={navigationPageOpen} aria-label="Open navigation" className="header-menu-button" onClick={openNavigationPage} variant="ghost"><IconMenu2 className="size-6" /></Button>
      )}
    </header>
  ) : null
  const foregroundContent = (
    <>
      <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
        <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} conversation={controller.conversation} />
      </div>
      {activeGroupId && <GroupChatScreen roomId={activeGroupId} />}
      {navigation.activeTab === 'capabilities' && <CapabilitiesScreen onBack={() => goBackOr(() => exitDestination('sessions'))} onNavigate={route => pushRoute('capabilities', route)} route={routeForCapabilities(activeRoute)} />}
      {navigation.activeTab === 'cron' && <CronScreen onBack={() => goBackOr(() => exitDestination('sessions'))} onNavigate={route => pushRoute('cron', route)} onOpenSession={async sessionId => { await controller.resumeSession(sessionId); clearMenuReturn(); setTab('sessions') }} route={routeForCron(activeRoute)} />}
      {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} onBack={() => goBackOr(() => exitDestination())} onNavigate={route => pushRoute('settings', route)} route={routeForSettings(activeRoute)} showModelBack={!returnTab} />}
    </>
  )

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        navigationPage={navigationPageOpen || inProfile ? <SessionsMenu controller={controller} onDismissRequest={navigationPage.requestDismiss} open={navigationPageOpen} /> : null}
        navigationPageOpen={navigationPageOpen}
        foreground={foregroundContent}
        foregroundDismissible={foregroundDismissible}
        foregroundHeader={foregroundHeader}
        foregroundNavigation={activeBotConfiguration ? <BotWorkspaceNavigation active={activeBotConfiguration} onSelect={selectBotWorkspaceDestination} /> : null}
        foregroundVisible={foregroundVisible}
        onDismissForeground={() => {
          // A committed swipe always dismisses the whole foreground to the
          // fixed roster. It changes only the in-memory route state.
          if (activeGroupId) resetTabRoutes('roster')
          if (navigation.activeTab === 'sessions' || activeGroupId) setTab('roster')
        }}
        onRefresh={refresh}
        reconnecting={reconnecting}
        refreshing={refreshing}
        roster={<RosterScreen onOpenAgent={openAgent} onOpenGroup={roomId => pushRoute('roster', { roomId, tab: 'roster', type: 'group-room' })} query={rosterQuery} />}
        rosterHeader={rosterHeader}
      />
    </GatewayProvider>
  )
}

function activeBotConfigurationDestination(tab: MobileTab, route: MobileRoute): 'capabilities' | 'cron' | 'model' | null {
  if (tab === 'capabilities' || tab === 'cron') return tab
  if (tab === 'settings' && route.type === 'settings-category' && route.category === 'model') return 'model'
  return null
}

function routeForCapabilities(route: ReturnType<typeof $activeRoute.get>): CapabilitiesRoute {
  return route.tab === 'capabilities' ? route : ROOT_ROUTES.capabilities
}

function routeForGroupRoom(route: ReturnType<typeof $activeRoute.get>): string | null {
  return route.tab === 'roster' && route.type === 'group-room' ? route.roomId : null
}

function routeForCron(route: ReturnType<typeof $activeRoute.get>): CronRoute {
  return route.tab === 'cron' ? route : ROOT_ROUTES.cron
}

function routeForSettings(route: ReturnType<typeof $activeRoute.get>): SettingsRoute {
  return route.tab === 'settings' ? route : ROOT_ROUTES.settings
}

function openDestination(tab: MobileTab) {
  resetTabRoutes(tab)
  setTab(tab)
}

function openModelSettings() {
  setTab('settings')
  const current = $navigation.get().stacks.settings.at(-1)
  if (current?.type === 'settings-category' && current.category === 'model') return
  resetTabRoutes('settings')
  pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })
}
