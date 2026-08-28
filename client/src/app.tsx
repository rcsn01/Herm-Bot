import { useStore } from '@nanostores/react'
import { IconMenu2 } from '@tabler/icons-react'
import { useEffect, useState } from 'react'

import { Badge, Button } from '~/compat/primitives'
import { ChatScreen } from '~/components/chat-screen'
import { ConnectScreen } from '~/components/connect-screen'
import { FilesScreen } from '~/components/files-screen'
import { MobileShell } from '~/components/mobile-shell'
import { SideNavigationDrawer } from '~/components/side-navigation-drawer'
import { applyTheme, SettingsScreen } from '~/components/settings-screen'
import { CapabilitiesScreen } from '~/features/capabilities/capabilities-screen'
import { MoreScreen, type MorePageId } from '~/features/more/more-screen'
import { OperationsScreen } from '~/features/operations/operations-screen'
import { RemoteResourceScreen, type RemoteResourceDefinition } from '~/features/shared/remote-resource'
import { GatewayProvider } from '~/gateway/gateway-context'
import { DeepLinkCoordinator } from '~/navigation/deep-links'
import { $activeRoute, $navigation, popRoute, pushRoute, setTab } from '~/navigation/navigation-store'
import { observeHermesDeepLinks } from '~/native/deep-links'
import { GatewayController } from '~/state/gateway-controller'
import { $chat, $connection, $preferences } from '~/state/store'

const controller = new GatewayController()
const deepLinks = new DeepLinkCoordinator(controller)

const DESTINATION_TITLES = {
  sessions: 'Sessions',
  capabilities: 'Capabilities',
  operations: 'Operations',
  more: 'More'
} as const

const MORE_RESOURCES: Record<Exclude<MorePageId, 'projects' | 'settings'>, RemoteResourceDefinition> = {
  billing: { id: 'billing', title: 'Billing', path: '/api/billing', description: 'Subscription, balance, and billing state when this gateway supports it.', profileScoped: false },
  learning: { id: 'learning', title: 'Learning', path: '/api/learning/graph', description: 'Profile memory and skill relationships.' },
  logs: { id: 'logs', title: 'Logs', path: '/api/logs', description: 'Recent remote gateway logs. Output is displayed as text, never HTML.' },
  profiles: { id: 'profiles', title: 'Profiles', path: '/api/profiles', description: 'Remote profiles, identity, model, and capability state.', profileScoped: false },
  system: { id: 'system', title: 'System', path: '/api/status', description: 'Gateway health, version, and remote maintenance availability.', profileScoped: false },
  usage: { id: 'usage', title: 'Usage', path: '/api/analytics/usage', description: 'Recent model, skill, tool, token, and cost activity.' }
}

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
    void controller.initialize()
    return () => controller.dispose()
  }, [])

  useEffect(() => observeHermesDeepLinks(rawURL => deepLinks.accept(rawURL)), [])
  useEffect(() => {
    deepLinks.setReady(connection.phase === 'connected')
    return () => deepLinks.setReady(false)
  }, [connection.phase])

  if (connection.phase === 'unsupported') {
    return <main className="blocking-screen"><div className="brand-mark">!</div><h1>Update remote Hermes</h1><p>{connection.error}</p><Button onClick={() => void controller.connect()}>Check again</Button></main>
  }
  if (connection.phase !== 'connected') return <ConnectScreen controller={controller} />

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
          <Button aria-controls="side-navigation-drawer" aria-expanded={drawerOpen} aria-label="Open navigation" className="header-menu-button" onClick={() => setDrawerOpen(true)} variant="ghost"><IconMenu2 size={21} /></Button>
          <div className="header-title"><span className={`connection-dot ${chat.running ? 'busy' : ''}`} /><div><strong>{headerTitle}</strong><small>{preferences.profile || 'default'} profile</small></div></div>
          <Button className="model-badge-button" onClick={() => { setTab('more'); if (activeRoute.type !== 'more-detail' || activeRoute.page !== 'settings') pushRoute('more', { type: 'more-detail', tab: 'more', page: 'settings' }) }} size="sm" variant="ghost" aria-label="Open settings"><Badge variant="muted">{chat.info?.model?.split('/').at(-1) || 'Hermes'}</Badge></Button>
        </header>}
        onOpenDrawer={() => setDrawerOpen(true)}
        onRefresh={refresh}
        refreshing={refreshing}
      >
        <div aria-hidden={navigation.activeTab !== 'sessions'} className={navigation.activeTab === 'sessions' ? '' : 'mounted-view-hidden'}>
          <ChatScreen controller={controller} />
        </div>
        {navigation.activeTab === 'capabilities' && <CapabilitiesScreen selected={activeRoute.type === 'capability-detail' ? activeRoute.capabilityId : undefined} onBack={() => popRoute('capabilities')} onSelect={capabilityId => pushRoute('capabilities', { type: 'capability-detail', tab: 'capabilities', capabilityId, capabilityType: capabilityType(capabilityId) })} />}
        {navigation.activeTab === 'operations' && <OperationsScreen selected={activeRoute.type === 'operation-detail' ? activeRoute.operationId : undefined} onBack={() => popRoute('operations')} onSelect={operationId => pushRoute('operations', { type: 'operation-detail', tab: 'operations', operationId, operationType: operationType(operationId) })} />}
        {navigation.activeTab === 'more' && <MoreRoute route={activeRoute} />}
      </MobileShell>
    </GatewayProvider>
  )
}

function MoreRoute({ route }: { route: ReturnType<typeof $activeRoute.get> }) {
  if (route.type !== 'more-detail') return <MoreScreen onSelect={page => pushRoute('more', { type: 'more-detail', tab: 'more', page })} />
  if (route.page === 'projects') return <section><BackButton /><FilesScreen /></section>
  if (route.page === 'settings') return <section><BackButton /><SettingsScreen controller={controller} /></section>
  return <RemoteResourceScreen definition={MORE_RESOURCES[route.page]} onBack={() => popRoute('more')} />
}

function BackButton() {
  return <div className="nested-back"><Button onClick={() => popRoute('more')} variant="text">‹ Back</Button></div>
}

function capabilityType(id: string): 'computer-use' | 'credential' | 'mcp' | 'memory' | 'model' | 'plugin' | 'provider' | 'skill' | 'tool' {
  if (id === 'computer-use' || id === 'mcp' || id === 'memory') return id
  if (id === 'credentials') return 'credential'
  if (id === 'models') return 'model'
  if (id === 'plugins') return 'plugin'
  if (id === 'providers') return 'provider'
  if (id === 'skills') return 'skill'
  return 'tool'
}

function operationType(id: string): 'agent' | 'cron' | 'messaging' | 'pairing' | 'webhook' {
  if (id === 'agents') return 'agent'
  if (id === 'cron' || id === 'messaging' || id === 'pairing') return id
  return 'webhook'
}
