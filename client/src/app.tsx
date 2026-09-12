import { useStore } from '@nanostores/react'
import { IconChevronLeft, IconMenu2, IconSearch, IconSettings } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'

import { Button, Input } from '~/compat/primitives'
import { BrandMark } from '~/components/brand-mark'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SideNavigationDrawer } from '~/components/side-navigation-drawer'
import { applyTheme } from '~/features/settings/settings-screen'
import { RosterScreen } from '~/features/agents/roster-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import type { CapabilitiesRoute, CronRoute, MobileTab, SettingsRoute } from '~/navigation/routes'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator } from '~/navigation/deep-links'
import { $activeRoute, $navigation, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
import { installScreenHistory, type ScreenHistory } from '~/navigation/screen-history'
import { ROOT_ROUTES } from '~/navigation/routes'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { $chat } from '~/state/conversation'
import { GatewayController } from '~/state/gateway-controller'
import { $connection, $preferences } from '~/state/store'

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
  const navigation = useStore($navigation)
  const activeRoute = useStore($activeRoute)
  const chat = useStore($chat)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [rosterQuery, setRosterQuery] = useState('')
  const [settingsOrigin, setSettingsOrigin] = useState<MobileTab>('roster')
  const screenHistoryRef = useRef<ScreenHistory | null>(null)

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

  // Mirror every screen into browser history so reloads, the Android system
  // back button and shared URLs all resolve to the screen the user was on.
  useEffect(() => {
    const app = installScreenHistory()
    screenHistoryRef.current = app
    return () => {
      app.dispose()
      screenHistoryRef.current = null
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
  // the roster, so it has no menu button or drawer.
  const inProfile = navigation.activeTab !== 'roster'

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark letter">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect().catch(() => undefined)}>Check again</Button></main>
  }
  if (connection.phase === 'connecting' || (connection.phase === 'reconnecting' && !reconnecting)) {
    return <main aria-label="Connecting to Hermes" className="blocking-screen startup-screen"><BrandMark small /><p role="status">Connecting…</p></main>
  }
  if (connection.phase !== 'connected' && !reconnecting) return <ConnectScreen controller={controller} />

  const refresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([controller.conversation.reconcileHistory(), controller.refreshSessions()])
    setRefreshing(false)
  }
  const openAgent = (profile: null | string) => {
    void controller.openProfile(profile).finally(() => setTab('sessions'))
  }
  /** In-app back rides browser history while an app entry sits behind it
   *  (so the system back gesture stays in sync); at the boundary the caller's
   *  action runs instead. */
  const goBackOr = (fallback: () => void) => {
    const app = screenHistoryRef.current
    if (app) app.goBack(fallback)
    else fallback()
  }
  /** The header chevron is a labeled destination ("Back to bots"), so it
   *  navigates explicitly — pushing "/" keeps the system back able to undo
   *  it. True back gestures use goBackOr instead. */
  const backToRoster = () => {
    setDrawerOpen(false)
    setTab('roster')
  }
  const openSettingsFrom = (origin: MobileTab) => {
    setSettingsOrigin(origin)
    resetTabRoutes('settings')
    setTab('settings')
  }
  const headerTitle = navigation.activeTab === 'sessions'
    ? ((chat.info as { title?: string } | null)?.title || 'New conversation')
    : DESTINATION_TITLES[navigation.activeTab]

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        drawer={inProfile ? <SideNavigationDrawer activeTab={navigation.activeTab} controller={controller} onClose={() => setDrawerOpen(false)} onNavigate={openDestination} onOpenModel={() => { setSettingsOrigin(navigation.activeTab); openModelSettings() }} open={drawerOpen} /> : null}
        drawerOpen={drawerOpen}
        header={<header className="app-header">
          {navigation.activeTab === 'roster' ? (
            <div className="header-search">
              <IconSearch aria-hidden size={17} />
              <Input aria-label="Search bots" onChange={event => setRosterQuery(event.target.value)} placeholder="Search bots" type="search" value={rosterQuery} />
            </div>
          ) : (
            <Button aria-label="Back to bots" className="header-back-button" onClick={backToRoster} variant="ghost"><IconChevronLeft className="size-6" /></Button>
          )}
          {navigation.activeTab === 'sessions' ? (
            <div className="header-bot-button">
              <span aria-hidden className={`connection-dot ${chat.running ? 'busy' : ''} ${reconnecting ? 'reconnecting' : ''}`} />
              <div><strong>{headerTitle}</strong><small>{reconnecting ? 'Reconnecting…' : `${preferences.profile || 'default'} profile`}</small></div>
            </div>
          ) : inProfile ? (
            <div className="header-title"><div><strong>{headerTitle}</strong></div></div>
          ) : null}
          {inProfile && (
            <Button aria-controls="side-navigation-drawer" aria-expanded={drawerOpen} aria-label="Open navigation" className="header-menu-button" onClick={() => setDrawerOpen(true)} variant="ghost"><IconMenu2 className="size-6" /></Button>
          )}
          {navigation.activeTab === 'roster' && (
            <Button aria-label="Open settings" className="header-gear-button" onClick={() => openSettingsFrom('roster')} variant="ghost"><IconSettings className="size-6" /></Button>
          )}
        </header>}
        onSwipeBack={() => { if (inProfile) goBackOr(() => setTab('roster')) }}        onRefresh={refresh}
        reconnecting={reconnecting}
        refreshing={refreshing}
      >
        <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
          <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} conversation={controller.conversation} />
        </div>
        {navigation.activeTab === 'roster' && <RosterScreen onOpenAgent={openAgent} query={rosterQuery} />}
        {navigation.activeTab === 'capabilities' && <CapabilitiesScreen onBack={() => goBackOr(() => popRoute('capabilities'))} onExit={() => setTab('sessions')} onNavigate={route => pushRoute('capabilities', route)} route={routeForCapabilities(activeRoute)} />}
        {navigation.activeTab === 'cron' && <CronScreen onBack={() => goBackOr(() => popRoute('cron'))} onExit={() => setTab('sessions')} onNavigate={route => pushRoute('cron', route)} onOpenSession={async sessionId => { await controller.resumeSession(sessionId); setTab('sessions') }} route={routeForCron(activeRoute)} />}
        {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} onBack={() => goBackOr(() => popRoute('settings'))} onExit={() => setTab(settingsOrigin)} onNavigate={route => pushRoute('settings', route)} route={routeForSettings(activeRoute)} />}
      </MobileShell>
    </GatewayProvider>
  )
}

function routeForCapabilities(route: ReturnType<typeof $activeRoute.get>): CapabilitiesRoute {
  return route.tab === 'capabilities' ? route : ROOT_ROUTES.capabilities
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
