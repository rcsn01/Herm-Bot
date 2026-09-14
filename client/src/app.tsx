import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconMenu2, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SideNavigationPage } from '~/components/side-navigation-page'
import { displayNameFor } from '~/features/agents/agent-labels'
import { GroupChatScreen } from '~/features/groups/group-screen'
import { $groups } from '~/features/groups/groups-store'
import { applyTheme } from '~/features/settings/settings-screen'
import { RosterScreen } from '~/features/agents/roster-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import type { CapabilitiesRoute, CronRoute, MobileTab, SettingsRoute } from '~/navigation/routes'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator, parseHermesDeepLink } from '~/navigation/deep-links'
import { restoreInitialNavigation } from '~/navigation/initial-navigation'
import { $activeRoute, $navigation, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
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
  cron: 'Cron Jobs',
  roster: 'Hermes',
  settings: 'Settings',
  sessions: 'Sessions'
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
  const initialNavigationRestoredRef = useRef(false)
  const navigationPage = useNavigationPageController({
    onDismissed: intent => {
      if (intent.type === 'tab') openDestination(intent.tab)
      else if (intent.type === 'model') openModelSettings()
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
  // The side navigation belongs to profile surfaces only; the main screen is
  // the roster, so it has no menu button or navigation page.
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
  const openAgent = (profile: null | string) => {
    // Enter the destination first; the wire work (profile switch, session
    // resume) streams into the already-visible chat shell.
    setTab('sessions')
    void controller.openProfile(profile)
  }
  /** In-app back pops the active in-memory route stack; at its root the
   *  caller's destination fallback runs instead. */
  const goBackOr = (fallback: () => void) => {
    if (popRoute(navigation.activeTab) === undefined) fallback()
  }
  /** The header chevron is a labeled destination ("Back to bots"), so it
   *  selects the roster explicitly rather than relying on browser history. */
  const backToRoster = () => {
    setTab('roster')
  }
  const openSettingsFrom = () => {
    resetTabRoutes('settings')
    setTab('settings')
  }
  const headerTitle = navigation.activeTab === 'sessions'
    ? displayNameFor({ name: preferences.profile || 'default' })
    : DESTINATION_TITLES[navigation.activeTab]
  /** The messaging header leads with the bot's identity (matching the roster
   *  and navigation labels) and carries the open session's name beneath it. */
  const headerSession = (chat.info as { title?: string } | null)?.title || 'New conversation'
  const foregroundVisible = navigation.activeTab !== 'roster' || Boolean(activeGroupId)
  const foregroundDismissible = navigation.activeTab === 'sessions' || Boolean(activeGroupId)
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
          <Button aria-label="Back to bots" className="header-back-button" onClick={() => goBackOr(() => popRoute('roster'))} variant="ghost"><IconChevronLeft className="size-6" /></Button>
          <div aria-level={1} className="header-title" role="heading"><div><strong>{activeGroup?.name ?? 'Group chat'}</strong></div></div>
        </>
      ) : (
        <Button aria-label="Back to bots" className="header-back-button" onClick={backToRoster} variant="ghost"><IconChevronLeft className="size-6" /></Button>
      )}
      {navigation.activeTab === 'sessions' ? (
        <div className="header-bot-button">
          <span aria-hidden className={`connection-dot ${chat.running ? 'busy' : ''} ${reconnecting ? 'reconnecting' : ''}`} />
          <div><strong>{headerTitle}</strong><small>{reconnecting ? 'Reconnecting…' : headerSession}</small></div>
        </div>
      ) : inProfile ? (
        <div aria-level={1} className="header-title" role="heading"><div><strong>{headerTitle}</strong></div></div>
      ) : null}
      {inProfile && (
        <Button aria-controls="side-navigation-page" aria-expanded={navigationPageOpen} aria-label="Open navigation" className="header-menu-button" onClick={navigationPage.openNavigationPage} variant="ghost"><IconMenu2 className="size-6" /></Button>
      )}
    </header>
  ) : null
  const foregroundContent = (
    <>
      <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
        <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} conversation={controller.conversation} />
      </div>
      {activeGroupId && <GroupChatScreen roomId={activeGroupId} />}
      {navigation.activeTab === 'capabilities' && <CapabilitiesScreen onBack={() => goBackOr(() => popRoute('capabilities'))} onExit={() => setTab('sessions')} onNavigate={route => pushRoute('capabilities', route)} route={routeForCapabilities(activeRoute)} />}
      {navigation.activeTab === 'cron' && <CronScreen onBack={() => goBackOr(() => popRoute('cron'))} onExit={() => setTab('sessions')} onNavigate={route => pushRoute('cron', route)} onOpenSession={async sessionId => { await controller.resumeSession(sessionId); setTab('sessions') }} route={routeForCron(activeRoute)} />}
      {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} onBack={() => goBackOr(() => popRoute('settings'))} onNavigate={route => pushRoute('settings', route)} route={routeForSettings(activeRoute)} />}
    </>
  )

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        navigationPage={navigationPageOpen || inProfile ? <SideNavigationPage activeTab={navigation.activeTab} controller={controller} onDismissRequest={navigationPage.requestDismiss} open={navigationPageOpen} /> : null}
        navigationPageOpen={navigationPageOpen}
        foreground={foregroundContent}
        foregroundDismissible={foregroundDismissible}
        foregroundHeader={foregroundHeader}
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
