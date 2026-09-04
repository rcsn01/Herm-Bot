import { useStore } from '@nanostores/react'
import { IconMenu2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button } from '~/compat/primitives'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SideNavigationDrawer } from '~/components/side-navigation-drawer'
import { applyTheme } from '~/features/settings/settings-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { CronScreen } from '~/features/cron/cron-screen'
import { SettingsScreen as MobileSettingsScreen } from '~/features/settings/settings-screen'
import type { CapabilitiesRoute, CronRoute, SettingsRoute } from '~/navigation/routes'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator } from '~/navigation/deep-links'
import { $activeRoute, $navigation, popRoute, pushRoute, resetTabRoutes, setTab } from '~/navigation/navigation-store'
import { ROOT_ROUTES } from '~/navigation/routes'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $preferences } from '~/state/store'

const controller = new GatewayController()
const deepLinks = new DeepLinkCoordinator(controller)

const DESTINATION_TITLES = {
  capabilities: 'Capabilities',
  cron: 'Cron Jobs',
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

  useEffect(() => {
    applyTheme(preferences.theme)
  }, [preferences.theme])

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

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect().catch(() => undefined)}>Check again</Button></main>
  }
  if (connection.phase !== 'connected' && !reconnecting) return <ConnectScreen controller={controller} />

  const refresh = async () => {
    setRefreshing(true)
    await Promise.allSettled([controller.reconcileHistory(), controller.refreshSessions()])
    setRefreshing(false)
  }
  const headerTitle = navigation.activeTab === 'sessions'
    ? ((chat.info as { title?: string } | null)?.title || 'New conversation')
    : DESTINATION_TITLES[navigation.activeTab]

  return (
    <GatewayProvider gateway={controller.gateway}>
      <MobileShell
        drawer={<SideNavigationDrawer activeTab={navigation.activeTab} controller={controller} onClose={() => setDrawerOpen(false)} onNavigate={setTab} open={drawerOpen} />}
        drawerOpen={drawerOpen}
        header={<header className="app-header">
          <Button aria-controls="side-navigation-drawer" aria-expanded={drawerOpen} aria-label="Open navigation" className="header-menu-button" onClick={() => setDrawerOpen(true)} variant="ghost"><IconMenu2 className="size-6" /></Button>
          <div className="header-title"><span className={`connection-dot ${chat.running ? 'busy' : ''} ${reconnecting ? 'reconnecting' : ''}`} /><div><strong>{headerTitle}</strong><small>{reconnecting ? 'Reconnecting…' : `${preferences.profile || 'default'} profile`}</small></div></div>
          <Button className="model-badge-button" onClick={openModelSettings} size="sm" variant="ghost" aria-label="Open model settings"><Badge variant="muted">{chat.info?.model?.split('/').at(-1) || 'Hermes'}</Badge></Button>
        </header>}
        onOpenDrawer={() => setDrawerOpen(true)}
        onRefresh={refresh}
        reconnecting={reconnecting}
        refreshing={refreshing}
      >
        <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
          <ChatScreen active={navigation.activeTab === 'sessions'} controller={controller} />
        </div>
        {navigation.activeTab === 'capabilities' && <CapabilitiesScreen onBack={() => popRoute('capabilities')} onNavigate={route => pushRoute('capabilities', route)} route={routeForCapabilities(activeRoute)} />}
        {navigation.activeTab === 'cron' && <CronScreen onBack={() => popRoute('cron')} onNavigate={route => pushRoute('cron', route)} onOpenSession={async sessionId => { await controller.resumeSession(sessionId); setTab('sessions') }} route={routeForCron(activeRoute)} />}
        {navigation.activeTab === 'settings' && <MobileSettingsScreen controller={controller} onBack={() => popRoute('settings')} onNavigate={route => pushRoute('settings', route)} route={routeForSettings(activeRoute)} />}
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

function openModelSettings() {
  setTab('settings')
  const current = $navigation.get().stacks.settings.at(-1)
  if (current?.type === 'settings-category' && current.category === 'model') return
  resetTabRoutes('settings')
  pushRoute('settings', { category: 'model', tab: 'settings', type: 'settings-category' })
}
